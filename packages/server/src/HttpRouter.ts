import {
  type HttpRouter as ConvexHttpRouter,
  httpActionGeneric,
  httpRouter,
  ROUTABLE_HTTP_METHODS,
  type RouteSpecWithPathPrefix,
  type GenericActionCtx,
  type GenericDataModel,
} from "convex/server";
import * as Array from "effect/Array";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as FindMyWay from "effect/http/FindMyWay";
import * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import type * as Etag from "effect/http/Etag";
import type * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import type * as ActionRunner from "./ActionRunner";
import type * as Auth from "./Auth";
import type { ExecutionMetadata } from "./ExecutionMetadata";
import type { RequestMetadata } from "./RequestMetadata";
import type * as DatabaseSchema from "./DatabaseSchema";
import type * as DataModel from "./DataModel";
import type * as Handler from "./Handler";
import * as ConvexConfigProvider from "./ConvexConfigProvider";
import * as ConvexLogger from "./ConvexLogger";
import type * as MutationRunner from "./MutationRunner";
import type * as QueryRunner from "./QueryRunner";
import * as RegisteredFunction from "./RegisteredFunction";
import type * as Scheduler from "./Scheduler";
import type { Storage } from "./Storage";
import type { StorageActionWriter } from "./StorageActionWriter";
import type { StorageReader } from "./StorageReader";
import type { StorageWriter } from "./StorageWriter";

/**
 * The Confect services available to HTTP route handlers and middleware,
 * supplied per request from the Convex action context.
 */
export type Services =
  | QueryRunner.QueryRunner
  | MutationRunner.MutationRunner
  | ActionRunner.ActionRunner
  | Scheduler.Scheduler
  | Auth.Auth
  | ExecutionMetadata
  | RequestMetadata
  | Storage
  | StorageReader
  | StorageWriter
  | StorageActionWriter;

/**
 * A layer that registers routes on the HTTP router—the input to {@link make}.
 *
 * Compose it from Effect's `effect/http` and `effect/http-api` modules:
 * `HttpApiBuilder.layer(api)` registers an `HttpApi`'s endpoints (provide its
 * group handler layers with `Layer.provide`), `HttpApiScalar.layer(api, ...)`
 * serves interactive API docs, `HttpRouter.add` registers a plain route, and
 * `HttpRouter.middleware(fn, { global: true })` applies middleware to every
 * route. Merge any number of these with `Layer.mergeAll`.
 *
 * Route handlers and middleware may require any of the Confect {@link Services},
 * which surface as request-level `Requires` markers and are supplied per
 * request. Anything else the layer requires is a type error—notably, an
 * `HttpApiBuilder.layer(api)` whose group handler layers are not provided
 * leaves an `HttpApiGroup.ToService` requirement behind, so a missing handler
 * group is caught at compile time.
 *
 * Layers are built with Confect's Convex-aware `ConfigProvider` in context, so
 * `Config` reads (e.g. in `Layer.unwrap`) resolve against Convex environment
 * variables.
 */
export type Routes<Services_ = Services> = Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | Etag.Generator
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
  | HttpRouter.Request<"Requires", Services_>
  | HttpRouter.Request<"GlobalRequires", Services_>
  | HttpRouter.Request<"Error", any>
  | HttpRouter.Request<"GlobalError", any>
>;

/**
 * Create a Convex HTTP router serving the given routes.
 *
 * A single catch-all `httpAction` is registered for every routable method under
 * the path prefix `"/"`, making the Effect router the single source of truth
 * for paths: place an API with `HttpApi.prefix` or absolute route paths.
 * Requests that match no route receive the Effect router's 404 response.
 *
 * Supply `{ api }` with the `HttpApi` registered by the routes layer to show
 * endpoint patterns in Convex completion logs and the dashboard. Requests that
 * match no reflected endpoint keep the catch-all completion label. Without the
 * option, Convex reports the catch-all registrations. Application endpoints
 * must not overlap component HTTP mounts: Convex also uses dashboard route
 * entries to select between application and component routers.
 *
 * Plain Convex routes can still be added to the returned router—Convex matches
 * exact paths first and longer path prefixes before the catch-all, so they take
 * precedence.
 */
export const make = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  routes: Routes,
  options?: { readonly api?: HttpApi.HttpApi<Id, Groups> | undefined },
): ConvexHttpRouter =>
  makeWithLayer(routes, RegisteredFunction.baseActionLayer, options?.api);

/**
 * Derive HTTP capabilities and ID scopes from the generated database schema.
 * Component routes are relative to their installation's HTTP mount prefix.
 * Supply `{ api }` as in {@link make}; labels stay component-relative.
 */
export const forSchema =
  <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
    schema: DatabaseSchema_,
  ) =>
  <Id extends string, Groups extends HttpApiGroup.Constraint>(
    routes: Routes<Handler.ActionServices<DatabaseSchema_>>,
    options?: { readonly api?: HttpApi.HttpApi<Id, Groups> | undefined },
  ): ConvexHttpRouter =>
    makeWithLayer<
      Handler.ActionServices<DatabaseSchema_>,
      DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>,
      Id,
      Groups
    >(
      Match.value(schema.target.kind).pipe(
        Match.when("app", () => routes),
        Match.when("component", () =>
          routes.pipe(Layer.provide(componentRouter)),
        ),
        Match.exhaustive,
      ),
      (ctx) => RegisteredFunction.actionLayer(schema, ctx),
      options?.api,
    );

// Convex uses a component-relative path to select its HTTP action but passes
// the original request URL to that action. Its CONVEX_SITE_URL includes the
// installation's full mount prefix (including parent mounts). Prefixing the
// Effect router preserves relative routes without rewriting the Request body.
const componentRouter = Layer.effect(
  HttpRouter.HttpRouter,
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const siteUrl = yield* Config.schema(
      Schema.URLFromString,
      "CONVEX_SITE_URL",
    );
    return router.prefixed(siteUrl.pathname);
  }).pipe(Effect.orDie),
);

const makeWithLayer = <
  Services_,
  DataModel_ extends GenericDataModel,
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
>(
  routes: Routes<Services_>,
  layer: (ctx: GenericActionCtx<DataModel_>) => Layer.Layer<Services_>,
  api: HttpApi.HttpApi<Id, Groups> | undefined,
): ConvexHttpRouter => {
  applyMonkeyPatches();

  // Provided (not just merged) so that route layers' own construction—e.g.
  // a `Layer.unwrap` reading `Config`—resolves configuration through the
  // Convex-aware provider; merged so that request fibers—endpoint handlers
  // and middleware—do too.
  const AppLayer = routes.pipe(
    Layer.provideMerge(ConvexLogger.layer),
    Layer.provideMerge(ConvexConfigProvider.layer),
    Layer.provide(HttpServer.layerServices),
  );

  // The Confect service requirements of route handlers and middleware surface
  // as request-level `Requires` markers on the layer, which the web handler
  // exposes as a per-request context argument.
  const { handler } = HttpRouter.toWebHandler(AppLayer, {
    disableLogger: true,
  });

  const httpAction = httpActionGeneric((ctx, request): Promise<Response> => {
    // The ctx-backed service layers are all synchronous and finalizer-free,
    // so the scope can close as soon as the context is built.
    // Convex's HTTP registration erases the data model. The supplied generated
    // schema restores it; this does not change the runtime context or services.
    const services = Effect.runSync(
      Effect.scoped(
        Layer.build(layer(ctx as unknown as GenericActionCtx<DataModel_>)),
      ),
    );
    return handler(
      request,
      Context.add(services, Console.Console, globalThis.console),
    );
  });

  const convexHttpRouter = httpRouter();

  Array.forEach(ROUTABLE_HTTP_METHODS, (method) => {
    const routeSpec: RouteSpecWithPathPrefix = {
      pathPrefix: "/",
      method,
      handler: httpAction,
    };
    convexHttpRouter.route(routeSpec);
  });

  if (api !== undefined) {
    const matcher = FindMyWay.make<string>();
    const reflected: ReturnType<ConvexHttpRouter["getRoutes"]> = [];
    HttpApi.reflect(api, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => {
        const method = ROUTABLE_HTTP_METHODS.find(
          (candidate) => candidate === endpoint.method,
        );
        if (method === undefined) return;
        const path = apiRouterPath(
          endpoint.path as FindMyWay.PathInput,
          endpoint.params,
        );
        matcher.on(method, path, endpoint.path);
        // Effect also matches a wildcard route's base path without its slash.
        if (path.endsWith("/*")) {
          matcher.on(method, path.slice(0, -2) as `/${string}`, endpoint.path);
        }
        reflected.push([endpoint.path, method, httpAction]);
      },
    });
    reflected.sort(
      ([pathA, methodA], [pathB, methodB]) =>
        pathA.localeCompare(pathB) || methodA.localeCompare(methodB),
    );

    const getRoutes = convexHttpRouter.getRoutes;
    convexHttpRouter.getRoutes = () =>
      reflected.length === 0
        ? getRoutes()
        : [
            ...getRoutes().filter(([, , action]) => action !== httpAction),
            ...reflected,
          ];
    const lookup = convexHttpRouter.lookup;
    convexHttpRouter.lookup = (path, method) => {
      const match = lookup(path, method);
      if (match === null || match[0] !== httpAction) return match;
      const normalized = match[1];
      const reflectedPath = matcher.find(normalized, path)?.handler;
      return reflectedPath === undefined
        ? match
        : [httpAction, normalized, reflectedPath];
    };
  }

  return convexHttpRouter;
};

/*!
 * apiRouterPath is adapted from Effect 4.0.1 http-api/internal/path.ts.
 *
 * MIT License
 *
 * Copyright (c) 2023 Effectful Technologies Inc
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Match Effect's HttpApiBuilder path normalization, which is not publicly
// exported (effect/http-api/internal/path.ts). Undeclared colons are literals;
// declared params followed by a literal suffix need an explicit regex boundary.
const apiRouterPath = (
  path: FindMyWay.PathInput,
  params: Schema.Top | undefined,
): FindMyWay.PathInput => {
  if (params === undefined || !path.includes(":")) return path;
  let ast = params.ast;
  while (ast.encoding !== undefined) {
    ast = ast.encoding[ast.encoding.length - 1].to;
  }
  if (!SchemaAST.isObjects(ast) || ast.indexSignatures.length !== 0)
    return path;
  const names = new Set(
    ast.propertySignatures.map((property) => String(property.name)),
  );
  let normalized = "";
  let depth = 0;
  let regexStart = -1;
  for (let i = 0; i < path.length; i++) {
    const char = path[i];
    if (depth > 0 || i === regexStart) {
      normalized += char;
      if (char === "\\") normalized += path[++i] ?? "";
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    } else if (char !== ":") {
      normalized += char;
    } else if (path[i + 1] === ":") {
      normalized += "::";
      i++;
    } else {
      const param = /^:(\w+)/.exec(path.slice(i));
      if (param !== null && names.has(param[1])) {
        normalized += param[0];
        i += param[0].length - 1;
        const next = path[i + 1];
        if (next === "(") regexStart = i + 1;
        else if (next !== undefined && !"/.-?".includes(next))
          normalized += "(.*?)";
      } else {
        normalized += "::";
      }
    }
  }
  return normalized as FindMyWay.PathInput;
};

// These are necessary until the Convex runtime supports these APIs. See
// https://discord.com/channels/1019350475847499849/1281364098419785760
// Each patch is applied only where the API is actually broken, so runtimes
// with working implementations—Node under convex-test, notably, where
// `new AbortSignal()` is an illegal constructor—keep their native behavior.
const applyMonkeyPatches = () => {
  const urlCredentialsBroken = (() => {
    try {
      return new URL("https://confect.dev").username === undefined;
    } catch {
      return true;
    }
  })();
  if (urlCredentialsBroken) {
    URL = class extends URL {
      override get username() {
        return "";
      }
      override get password() {
        return "";
      }
    };
  }

  const requestSignalBroken = (() => {
    try {
      return new Request("https://confect.dev").signal === undefined;
    } catch {
      return true;
    }
  })();
  if (requestSignalBroken) {
    // `configurable` so repeated definition—e.g. module re-evaluation in a
    // long-lived environment—does not throw.
    Object.defineProperty(Request.prototype, "signal", {
      get: () => new AbortSignal(),
      configurable: true,
    });
  }
};
