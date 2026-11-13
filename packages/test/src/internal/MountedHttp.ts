/* oxlint-disable effecttsgo/async-function -- This convex-test adapter uses Promise callbacks and temporarily overrides the real process environment consumed by HTTP module construction. */
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
import * as Execution from "./Execution.js";
import * as Http from "./Http.js";

declare const process: { env: Record<string, string | undefined> };

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

export const make = (
  mounts: ReadonlyArray<HttpMount>,
  registerComponent: RegisterComponent,
) => {
  const normalized = normalizeMounts(mounts);
  if (Result.isFailure(normalized)) throw normalized.failure;
  const registered = new Set<string>();
  let tail = Promise.resolve();
  let nextErrorRequest = 1;

  const register: RegisterComponent = (
    componentPath,
    schema,
    modules,
    options,
  ) => {
    if (
      !Arr.some(
        normalized.success,
        (mount) => mount.componentPath === componentPath,
      )
    ) {
      registerComponent(componentPath, schema, modules, options);
      return;
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
    const routers = new Map<string, Promise<HttpRouter>>();
    const invoke = actionGeneric({
      handler: async (_ctx, args: HttpRequest): Promise<HttpResponse> => {
        const previousSiteUrl = process.env.CONVEX_SITE_URL;
        try {
          process.env.CONVEX_SITE_URL = args.siteUrl;
          let router = routers.get(args.siteUrl);
          if (router === undefined) {
            router = loadHttp().then(
              (module: { default: HttpRouter }) => module.default,
            );
            routers.set(args.siteUrl, router);
          }
          const route = (await router).lookup(
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
        } finally {
          if (previousSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
          else process.env.CONVEX_SITE_URL = previousSiteUrl;
        }
      },
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
    registerComponent(
      componentPath,
      schema,
      { ...backendModules, [bridgePath]: () => Promise.resolve({ invoke }) },
      options,
    );
    registered.add(componentPath);
  };

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
      const appSiteUrl = pipe(
        process.env.CONVEX_SITE_URL || defaultSiteUrl,
        String.replace(/\/$/, ""),
      );
      // The body goes before the request is built: a GET or HEAD request with
      // one cannot be built at all, and the binary discards it anyway.
      const request = new Request(
        new URL(`${appSiteUrl}${path}`),
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
        siteUrl: `${appSiteUrl}${mount.prefix}`,
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

  return { register, fetch };
};
