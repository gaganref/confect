/* oxlint-disable effecttsgo/async-function -- This convex-test adapter uses Promise callbacks around HTTP module construction and handler invocation. */
import type { TestConvexForDataModel } from "convex-test";
import type {
  GenericDataModel,
  HttpRouter,
  FunctionReference,
  RoutableMethod,
  PublicHttpAction,
} from "convex/server";
import { actionGeneric } from "convex/server";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { HttpMount, RegisterComponent } from "../TestConfect.js";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Environment from "./Environment.js";
import * as Execution from "./Execution.js";
import * as Http from "./Http.js";

class InvalidHttpMount extends Schema.TaggedError<
  InvalidHttpMount,
  { readonly brand: unique symbol }
>()("InvalidHttpMount", {
  componentPath: Schema.String,
  httpPrefix: Schema.String,
  message: Schema.String,
}) {}

class ComponentHttpError extends Schema.TaggedError<
  ComponentHttpError,
  { readonly brand: unique symbol }
>()("ComponentHttpError", {
  componentPath: Schema.String,
  message: Schema.String,
}) {}

class InvalidFetchPath extends Schema.TaggedError<
  InvalidFetchPath,
  { readonly brand: unique symbol }
>()("InvalidFetchPath", { path: Schema.String, message: Schema.String }) {}

type NormalizedMount = {
  readonly componentPath: string;
  readonly prefix: string;
};

const normalizeMounts = (mounts: ReadonlyArray<HttpMount>) => {
  const normalized: Array<NormalizedMount> = [];
  for (const mount of mounts) {
    if (
      !pipe(mount.httpPrefix, String.startsWith("/")) ||
      /[?#]/.test(mount.httpPrefix)
    ) {
      return Result.fail(
        InvalidHttpMount.make({
          ...mount,
          message:
            "httpPrefix must be an absolute path without a query or fragment.",
        }),
      );
    }
    const prefix = pipe(mount.httpPrefix, String.replace(/\/+$/, ""));
    if (Arr.some(normalized, (previous) => previous.prefix === prefix)) {
      return Result.fail(
        InvalidHttpMount.make({
          ...mount,
          message: "Each httpPrefix must select one component installation.",
        }),
      );
    }
    normalized.push({ componentPath: mount.componentPath, prefix });
  }
  return Result.succeed(
    normalized.sort((a, b) => b.prefix.length - a.prefix.length),
  );
};

type HttpRequest = {
  siteUrl: string;
  url: string;
  pathname: string;
  method: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
};

type HttpResponse = {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer;
};

// Convex omits this runtime entry point from its published declarations.
const isInvokable = (
  action: PublicHttpAction,
): action is PublicHttpAction & {
  invokeHttpAction(request: Request): Promise<Response>;
} =>
  "invokeHttpAction" in action && typeof action.invokeHttpAction === "function";

const bridgeModule = "__confect_test_http";
const defaultSiteUrl = "https://some.convex.site";

/**
 * Load a module a component's backend builds outside its own load, as the test
 * kernel's `loadOutside` does under its load rules. Without one, the module
 * loads as convex-test loads it.
 */
export type LoadOutside = (
  componentPath: string,
  modulePath: string,
  load: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * A component's registration, made but not yet installed: the modules and
 * options the backend registers it with, its mounted router's loader, built at
 * its mount's site URL and kept for its requests, and `install`, which
 * registers it through `register` and serves its routes from then on.
 */
export interface Prepared {
  readonly modules: Record<string, () => Promise<any>>;
  readonly options: Parameters<RegisterComponent>[3];
  readonly httpModule: (() => Promise<unknown>) | undefined;
  readonly install: (register: RegisterComponent) => void;
}

export const make = (
  mounts: ReadonlyArray<HttpMount>,
  registerComponent: RegisterComponent,
  loadOutside?: LoadOutside,
) => {
  const normalized = normalizeMounts(mounts);
  if (Result.isFailure(normalized)) throw normalized.failure;
  // Before any mounted router builds, so a proxy that cannot give it its
  // mount's site URL refuses the backend, rather than serve unprefixed routes.
  if (normalized.success.length > 0) Environment.requireSiteUrlOverride();
  const registered = new Set<string>();
  /**
   * Each mounted component's HTTP module, built at its mount's site URL, by
   * component path.
   */
  const httpModules = new Map<string, (siteUrl: string) => Promise<unknown>>();
  // The host's own site URL, which no mount's override changes.
  const appSiteUrl = () =>
    pipe(
      Environment.hostValue("CONVEX_SITE_URL") || defaultSiteUrl,
      String.replace(/\/$/, ""),
    );
  let tail = Promise.resolve();
  let nextErrorRequest = 1;

  const prepare = (
    componentPath: string,
    schema: Parameters<RegisterComponent>[1],
    modules: Record<string, () => Promise<any>>,
    options: Parameters<RegisterComponent>[3],
    // How the router loads instead, as for a component staged on the kernel,
    // which `loadOutside` cannot find until it is registered.
    loadVia: LoadOutside | undefined = loadOutside,
  ): Prepared => {
    const mount = Option.getOrUndefined(
      Arr.findFirst(
        normalized.success,
        (each) => each.componentPath === componentPath,
      ),
    );
    if (mount === undefined) {
      return {
        modules,
        options,
        httpModule: undefined,
        install: (register) =>
          register(componentPath, schema, modules, options),
      };
    }
    const generated = Option.getOrUndefined(
      Arr.findFirst(Rec.keys(modules), (key) =>
        pipe(key, String.includes("_generated")),
      ),
    );
    const root =
      generated === undefined
        ? undefined
        : pipe(generated, String.split("_generated"))[0];
    const moduleLoaders = Rec.fromEntries(
      Arr.map(Rec.toEntries(modules), ([path, load]) => [
        pipe(path, String.replace(/\.[^.]+$/, "")),
        load,
      ]),
    );
    const loadHttp =
      root === undefined ? undefined : moduleLoaders[`${root}http`];
    if (root === undefined || loadHttp === undefined) {
      throw ComponentHttpError.make({
        componentPath,
        message:
          "Mounted components need an HTTP module and Convex _generated modules.",
      });
    }
    const bridgePath = `${root}${bridgeModule}.ts`;
    if (`${root}${bridgeModule}` in moduleLoaders) {
      throw ComponentHttpError.make({
        componentPath,
        message: `${bridgeModule} is reserved for mounted HTTP tests.`,
      });
    }
    // The component's HTTP module, built once per site URL, as its mount's
    // deployment builds it: its code reads that URL as `CONVEX_SITE_URL`, and
    // the host's environment, which other backends read, stays as it is. On
    // the kernel it loads under the component's load rules, its environment,
    // guards and seeded random stream.
    const routers = new Map<string, Promise<{ default: HttpRouter }>>();
    const httpModuleAt = (siteUrl: string) => {
      let built = routers.get(siteUrl);
      if (built === undefined) {
        built = Environment.withSiteUrl(siteUrl, () =>
          loadVia === undefined
            ? Promise.resolve().then(loadHttp)
            : loadVia(componentPath, `${root}http`, loadHttp),
        ) as Promise<{ default: HttpRouter }>;
        routers.set(siteUrl, built);
      }
      return built;
    };
    const invoke = actionGeneric({
      handler: (_ctx, args: HttpRequest): Promise<HttpResponse> =>
        // The handler reads its mount's site URL, as the router's load did.
        Environment.withSiteUrl(args.siteUrl, async () => {
          const router = (await httpModuleAt(args.siteUrl)).default;
          const route = router.lookup(
            args.pathname,
            args.method as RoutableMethod,
          );
          let response: Response;
          if (route === null) {
            // The binary answers a mounted router's miss as a root one's.
            response = Http.noRoute();
          } else {
            const action = route[0];
            if (!isInvokable(action)) {
              throw ComponentHttpError.make({
                componentPath,
                message:
                  "This Convex version does not expose invokeHttpAction for HTTP tests.",
              });
            }
            // Convex selects on the relative path and passes the full URL to the handler.
            // A handler that throws gets the binary's 500, as on the root.
            response = await action
              .invokeHttpAction(
                new Request(args.url, {
                  method: args.method,
                  headers: args.headers,
                  ...(args.body === null ? {} : { body: args.body }),
                }),
              )
              .catch((thrown: unknown) => {
                // A kernel refusal is no handler error: it surfaces as itself.
                const refusal = Execution.currentRefusal(thrown);
                if (refusal !== undefined) throw refusal;
                // The report is an artifact: a kept secret in it is marked.
                return Http.serverError(
                  Execution.redactCurrentFailure(thrown),
                  Http.errorRequestId(nextErrorRequest++),
                );
              });
          }
          return {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers],
            body: await response.arrayBuffer(),
          };
        }),
    });
    // The bridge runs the component's `http.ts` routes, which Convex runs in
    // its isolate, so it carries Confect's isolate mark, and a source with no
    // `"use node"` directive when the component's sources are given.
    Object.defineProperty(invoke, Symbol.for("@confect/server/NodeAction"), {
      value: false,
    });
    // The bridge builds the component's router itself, once per site URL, as
    // a deployment builds a mounted component's router at its mount. So the
    // backend never loads the HTTP module on its own: the test kernel would
    // otherwise construct it at open, under no mount's site URL.
    const backendModules = Rec.fromEntries(
      Arr.filter(
        Rec.toEntries(modules),
        ([path]) =>
          pipe(path, String.replace(/\.[^.]+$/, "")) !== `${root}http`,
      ),
    );
    const bridged = {
      ...backendModules,
      [bridgePath]: () => Promise.resolve({ invoke }),
    };
    const bridgedOptions =
      options?.sources === undefined
        ? options
        : {
            ...options,
            sources: {
              ...options.sources,
              // The bridge is an isolate module that exports `invoke`.
              [bridgePath]: () => Promise.resolve("export {};\n"),
            },
          };
    return {
      modules: bridged,
      options: bridgedOptions,
      httpModule: () => httpModuleAt(`${appSiteUrl()}${mount.prefix}`),
      install: (register) => {
        register(componentPath, schema, bridged, bridgedOptions);
        httpModules.set(componentPath, httpModuleAt);
        registered.add(componentPath);
      },
    };
  };

  const register: RegisterComponent = (
    componentPath,
    schema,
    modules,
    options,
  ) =>
    prepare(componentPath, schema, modules, options).install(registerComponent);

  const fetch = <DataModel extends GenericDataModel>(
    accessor: TestConvexForDataModel<DataModel>,
    path: string,
    init?: RequestInit,
  ): Promise<Response> => {
    if (normalized.success.length === 0) return accessor.fetch(path, init);
    const run = async () => {
      if (!pipe(path, String.startsWith("/"))) {
        throw InvalidFetchPath.make({
          path,
          message: 'Path given to fetch must start with a "/".',
        });
      }
      const pathname = new URL(`${defaultSiteUrl}${path}`).pathname;
      const mount = Option.getOrUndefined(
        Arr.findFirst(
          normalized.success,
          ({ prefix }) =>
            pathname === prefix ||
            pipe(pathname, String.startsWith(`${prefix}/`)),
        ),
      );
      if (mount === undefined) return accessor.fetch(path, init);
      if (!registered.has(mount.componentPath)) {
        throw ComponentHttpError.make({
          componentPath: mount.componentPath,
          message: "Register the mounted component before calling fetch.",
        });
      }
      const siteUrl = appSiteUrl();
      // The body goes before the request is built: a GET or HEAD request with
      // one cannot be built at all, and the binary discards it anyway.
      const request = new Request(
        new URL(`${siteUrl}${path}`),
        Http.discardsBody(init?.method ?? "GET")
          ? { ...init, body: null }
          : init,
      );
      // convex-test encodes exact component paths in test-only function handles.
      const reference =
        `function://${mount.componentPath};${bridgeModule}:invoke` as unknown as FunctionReference<
          "action",
          "public",
          HttpRequest,
          HttpResponse
        >;
      const response = await accessor.action(reference, {
        siteUrl: `${siteUrl}${mount.prefix}`,
        url: request.url,
        pathname: pipe(pathname, String.slice(mount.prefix.length)) || "/",
        method: request.method,
        headers: [...request.headers],
        body: Http.discardsBody(request.method)
          ? null
          : await request.arrayBuffer(),
      });
      return new Response(
        request.method === "HEAD" || [204, 205, 304].includes(response.status)
          ? null
          : response.body,
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    };
    const result = tail.then(run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /**
   * A loader of the mounted component's HTTP module, built at the site URL its
   * mount gives it and kept for `fetch`, or `undefined` for a component that is
   * not mounted, so a test backend can read the router before it serves.
   */
  const httpModule = (
    componentPath: string,
  ): (() => Promise<unknown>) | undefined => {
    const at = httpModules.get(componentPath);
    const mount = Arr.findFirst(
      normalized.success,
      (each) => each.componentPath === componentPath,
    );
    return at === undefined || Option.isNone(mount)
      ? undefined
      : () => at(`${appSiteUrl()}${mount.value.prefix}`);
  };

  return { register, prepare, fetch, httpModule };
};
