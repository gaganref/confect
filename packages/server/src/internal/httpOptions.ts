import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

/* oxlint-disable effecttsgo/any-unknown-in-error-context -- Preserve the router's erased request errors at the routing boundary. */

type Route = Parameters<HttpRouter.HttpRouter["addAll"]>[0][number];

const notFound = Effect.flatMap(
  HttpServerRequest.HttpServerRequest,
  (request) =>
    Effect.fail(
      new HttpServerError.HttpServerError({
        reason: new HttpServerError.RouteNotFound({ request }),
      }),
    ),
);

// Effect's router adds `/a/:b` and `/a` for `/a/:b?` in one call, so an earlier
// `/a/:id` rejects both. Split the same way, each form claims `first` alone.
const optional = /(\/:[^/()]*?)\?(\/?)/;
const forms = (path: Route["path"]) =>
  (optional.test(path)
    ? [path.replace(optional, "$1$2"), path.replace(optional, "$2") || "/"]
    : [path]) as ReadonlyArray<Route["path"]>;

const missingRouteContext = `Service not found: ${HttpRouter.RouteContext.key}`;

// WORKAROUND: Effect 4.0.4 compiles endpoint middleware, decoding and the
// handler into one route handler. Its endpoint body reads RouteContext before
// decoding or calling the handler, so without RouteContext a preflight that
// middleware passes on stops there. Remove when Effect can run an endpoint's
// middleware around another handler.
const preflight = (handler: Route["handler"]) =>
  handler.pipe(
    Effect.updateContext(Context.omit(HttpRouter.RouteContext)),
    Effect.catchDefect((defect) =>
      defect instanceof Error && defect.message === missingRouteContext
        ? notFound
        : Effect.die(defect),
    ),
  );

export const withOptions = <A, E, R>(
  routes: Layer.Layer<A, E, R>,
  endpoints: ReadonlySet<string>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const registered: Array<{
        readonly route: Route;
        readonly prefix: string;
        readonly context: Context.Context<never>;
      }> = [];
      const wrap = (
        target: HttpRouter.HttpRouter,
        prefix: string,
      ): HttpRouter.HttpRouter => {
        const addAll: HttpRouter.HttpRouter["addAll"] = (entries) =>
          Effect.contextWith((context: Context.Context<never>) => {
            for (const route of entries)
              registered.push({ route, prefix, context });
            return target.addAll(entries);
          });
        return HttpRouter.HttpRouter.of({
          ...target,
          addAll,
          add: (method, path, handler, options) =>
            addAll([HttpRouter.route(method, path, handler, options)]),
          prefixed: (next) =>
            wrap(target.prefixed(next), `${prefix}${next.replace(/\/$/, "")}`),
        });
      };
      const register = Effect.gen(function* () {
        // Effect's routers decide which paths match: one per declared method,
        // and `first`, which refuses a path equivalent to an earlier one.
        const byMethod = new Map<string, HttpRouter.HttpRouter>();
        const first = yield* HttpRouter.make;
        const explicit = yield* HttpRouter.make;
        for (const { route, prefix, context } of registered) {
          const at = (target: HttpRouter.HttpRouter) =>
            prefix === "" ? target : target.prefixed(prefix);
          if (route.method === "OPTIONS" || route.method === "*") {
            yield* at(explicit).addAll([{ ...route, handler: notFound }]);
            continue;
          }
          const copy: Route = {
            ...route,
            method: "OPTIONS",
            handler: endpoints.has(`${route.method} ${route.path}`)
              ? preflight(route.handler)
              : notFound,
          };
          const candidate =
            byMethod.get(route.method) ?? (yield* HttpRouter.make);
          byMethod.set(route.method, candidate);
          // Route registration erases request requirements, as in Effect's router.
          yield* Effect.provideContext(at(candidate).addAll([copy]), context);
          for (const path of forms(copy.path)) {
            const form = at(first).addAll([{ ...copy, path }]);
            yield* Effect.exit(Effect.provideContext(form, context));
          }
        }
        // Effect's router answers HEAD from GET where no HEAD route matches. The
        // root wildcard matches last, unless a HEAD route already claims it.
        const get = byMethod.get("GET");
        if (get !== undefined) {
          const head = byMethod.get("HEAD") ?? (yield* HttpRouter.make);
          byMethod.set("HEAD", head);
          yield* Effect.exit(head.add("OPTIONS", "*", get.asHttpEffect()));
        }
        // An explicit OPTIONS route on the root wildcard answers every path.
        const claimed = yield* Effect.exit(
          explicit.add("OPTIONS", "*", notFound),
        );
        if (Exit.isFailure(claimed)) return;
        const candidates = new Map(
          Array.from(byMethod, ([method, candidate]) => [
            method,
            candidate.asHttpEffect(),
          ]),
        );
        const fallback = first.asHttpEffect();
        // The root wildcard matches last, so explicit OPTIONS routes still win.
        yield* router.add(
          "OPTIONS",
          "*",
          Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
            const method = request.headers["access-control-request-method"];
            return method === undefined
              ? fallback
              : (candidates.get(method) ?? notFound);
          }),
        );
      });
      return Layer.effectDiscard(register).pipe(
        Layer.provideMerge(
          routes.pipe(
            Layer.provide(
              Layer.succeed(HttpRouter.HttpRouter, wrap(router, "")),
            ),
          ),
        ),
      );
    }),
  );
