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
import type { HttpMount, RegisterComponent } from "../TestConfect";

declare const process: { env: Record<string, string | undefined> };

class InvalidHttpMount extends Schema.TaggedError<InvalidHttpMount>()(
  "InvalidHttpMount",
  {
    componentPath: Schema.String,
    httpPrefix: Schema.String,
    message: Schema.String,
  },
) {}

class ComponentHttpError extends Schema.TaggedError<ComponentHttpError>()(
  "ComponentHttpError",
  { componentPath: Schema.String, message: Schema.String },
) {}

class InvalidFetchPath extends Schema.TaggedError<InvalidFetchPath>()(
  "InvalidFetchPath",
  { path: Schema.String, message: Schema.String },
) {}

type NormalizedMount = {
  readonly componentPath: string;
  readonly prefix: string;
};

const normalizeMounts = (mounts: ReadonlyArray<HttpMount>) => {
  const normalized: Array<NormalizedMount> = [];
  for (const mount of mounts) {
    if (!mount.httpPrefix.startsWith("/") || /[?#]/.test(mount.httpPrefix)) {
      return Result.fail(
        new InvalidHttpMount({
          ...mount,
          message:
            "httpPrefix must be an absolute path without a query or fragment.",
        }),
      );
    }
    const prefix = mount.httpPrefix.replace(/\/+$/, "");
    if (normalized.some((previous) => previous.prefix === prefix)) {
      return Result.fail(
        new InvalidHttpMount({
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

  const register: RegisterComponent = (componentPath, schema, modules) => {
    if (
      !normalized.success.some((mount) => mount.componentPath === componentPath)
    ) {
      registerComponent(componentPath, schema, modules);
      return;
    }
    const generated = Object.keys(modules).find((key) =>
      key.includes("_generated"),
    );
    const root = generated?.split("_generated", 2)[0];
    const moduleLoaders = Object.fromEntries(
      Object.entries(modules).map(([path, load]) => [
        path.replace(/\.[^.]+$/, ""),
        load,
      ]),
    );
    const loadHttp =
      root === undefined ? undefined : moduleLoaders[`${root}http`];
    if (root === undefined || loadHttp === undefined) {
      throw new ComponentHttpError({
        componentPath,
        message:
          "Mounted components need an HTTP module and Convex _generated modules.",
      });
    }
    const bridgePath = `${root}${bridgeModule}.ts`;
    if (`${root}${bridgeModule}` in moduleLoaders) {
      throw new ComponentHttpError({
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
            response = new Response(
              `No HttpAction routed for ${args.pathname}`,
              { status: 404 },
            );
          } else {
            const action = route[0];
            if (!isInvokable(action)) {
              throw new ComponentHttpError({
                componentPath,
                message:
                  "This Convex version does not expose invokeHttpAction for HTTP tests.",
              });
            }
            // Convex selects on the relative path and passes the full URL to the handler.
            response = await action.invokeHttpAction(
              new Request(args.url, {
                method: args.method,
                headers: args.headers,
                ...(args.body === null ? {} : { body: args.body }),
              }),
            );
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
    registerComponent(componentPath, schema, {
      ...modules,
      [bridgePath]: () => Promise.resolve({ invoke }),
    });
    registered.add(componentPath);
  };

  const fetch = <DataModel extends GenericDataModel>(
    accessor: TestConvexForDataModel<DataModel>,
    path: string,
    init?: RequestInit,
  ): Promise<Response> => {
    if (normalized.success.length === 0) return accessor.fetch(path, init);
    const run = async () => {
      if (!path.startsWith("/")) {
        throw new InvalidFetchPath({
          path,
          message: 'Path given to fetch must start with a "/".',
        });
      }
      const pathname = new URL(`${defaultSiteUrl}${path}`).pathname;
      const mount = normalized.success.find(
        ({ prefix }) =>
          pathname === prefix || pathname.startsWith(`${prefix}/`),
      );
      if (mount === undefined) return accessor.fetch(path, init);
      if (!registered.has(mount.componentPath)) {
        throw new ComponentHttpError({
          componentPath: mount.componentPath,
          message: "Register the mounted component before calling fetch.",
        });
      }
      const appSiteUrl = (
        process.env.CONVEX_SITE_URL || defaultSiteUrl
      ).replace(/\/$/, "");
      const request = new Request(new URL(`${appSiteUrl}${path}`), init);
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
        pathname: pathname.slice(mount.prefix.length) || "/",
        method: request.method,
        headers: [...request.headers],
        body:
          request.method === "GET" || request.method === "HEAD"
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
