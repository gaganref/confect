import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Cookies from "effect/http/Cookies";
import * as FindMyWay from "effect/http/FindMyWay";
import * as Headers from "effect/http/Headers";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import type { GenericDataModel } from "convex/server";
import * as ActionCtx from "../ActionCtx.js";
import * as Guard from "../Guard.js";
import * as Routes from "../Routes.js";
import { identities, type RouteIdentity } from "./routeIdentity.js";
import * as RouteOverlap from "./routeOverlap.js";

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
    ? [
        pipe(path, String.replace(optional, "$1$2")),
        pipe(path, String.replace(optional, "$2")) || "/",
      ]
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

/**
 * @internal
 *
 * How the router admits route specs: the backend's guard, the route specs its
 * api list reflects by method and path, and the prefix every route spec's
 * registration carries (a component's mount, or none).
 */
export interface Admission {
  readonly guard: Guard.Guard | undefined;
  readonly reflected: ReadonlyMap<string, RouteIdentity>;
  readonly mount: Effect.Effect<string>;
}

interface Registration {
  readonly route: Route;
  readonly prefix: string;
  readonly context: Context.Context<never>;
  readonly identity: RouteIdentity | null;
}

/**
 * The route spec the guard admitted the request for, read again after each
 * product global middleware.
 */
const Admitted = Context.Reference<RouteIdentity | null>(
  "@confect/server/internal/httpOptions/Admitted",
  { defaultValue: () => null },
);

// Effect's own answer when a failure's response cannot be built.
const internalError = HttpServerResponse.empty({ status: 500 });

// Convex's id for the request, where its ctx can give one.
const currentRequestId = Effect.serviceOption(
  ActionCtx.ActionCtx<GenericDataModel>(),
).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.undefined,
      onSome: (ctx) =>
        Effect.map(
          Effect.promise(() => ctx.meta.getRequestMetadata()),
          ({ requestId }): string | undefined => requestId,
        ),
    }),
  ),
  Effect.catchCause(() => Effect.undefined),
);

/**
 * Logs a route request's server failure at error level, annotated with the
 * request id and the route's function path and nothing else of the request,
 * since no response carries its cause.
 */
const report = (route: RouteIdentity, cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    const requestId = yield* currentRequestId;
    yield* Effect.logError(cause).pipe(
      Effect.annotateLogs({
        ...(requestId === undefined ? {} : { requestId }),
        functionPath: route.functionPath,
      }),
    );
  });

const failed = (route: RouteIdentity, cause: Cause.Cause<unknown>) =>
  Effect.as(report(route, cause), internalError);

// Every failure as its response, logged when it answers 5xx. A conversion that
// throws or fails ends the product's fiber, which answers Effect's 500.
const respond = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  route: RouteIdentity,
) =>
  Effect.catchCause(effect, (cause) =>
    Effect.suspend(() => HttpServerError.causeResponse(cause)).pipe(
      Effect.map(([response]) => response),
      Effect.tap((response) =>
        response.status >= 500 ? report(route, cause) : Effect.void,
      ),
    ),
  );

/**
 * The response as Effect will send it, read in full and rebuilt from what was
 * read, so nothing product code holds produces or changes it later. A stream
 * body runs here, on the product's fiber and in its scope.
 */
const materialize = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    const { body } = response;
    const read =
      body._tag === "Stream"
        ? yield* Effect.map(Stream.mkUint8Array(body.stream), (bytes) =>
            HttpServerResponse.setBody(
              response,
              HttpBody.uint8Array(bytes, body.contentType),
            ),
          )
        : response;
    const sent = HttpServerResponse.toWeb(read);
    const empty = sent.body === null;
    const bytes = yield* Effect.promise(() => sent.arrayBuffer());
    const headers = new globalThis.Headers(sent.headers);
    const cookies = Cookies.fromSetCookie(headers.getSetCookie());
    headers.delete("set-cookie");
    const owned = HttpServerResponse.empty({
      status: sent.status,
      statusText: sent.statusText,
      headers: Headers.fromInput(headers),
      cookies,
    });
    return empty
      ? owned
      : HttpServerResponse.setBody(
          owned,
          HttpBody.uint8Array(
            new Uint8Array(bytes),
            headers.get("content-type") ?? undefined,
          ),
        );
  });

// WORKAROUND: Effect 4.1.4 keeps a request's pre-response handlers on its
// request state, which it does not export, and runs them after every
// middleware, the guard included. The gate reads the state by its key to give
// product code its own handler slot. Remove when Effect lets a middleware scope
// pre-response handlers.
/**
 * @internal
 */
export class RequestState extends Context.Service<
  RequestState,
  { preResponseHandler: HttpEffect.PreResponseHandler | undefined }
  // oxlint-disable-next-line effecttsgo/deterministic-keys -- The key is Effect's own, so the lookup finds its request state.
>()("effect/http/HttpEffect/CurrentRequestState") {}

/**
 * The request state product code sees: a pre-response handler slot of its own
 * and the request's other fields, taking no writes once closed.
 */
const ownRequestState = (state: RequestState["Service"]) => {
  let registered: HttpEffect.PreResponseHandler | undefined;
  let open = true;
  return {
    state: new Proxy(state, {
      get: (target, key) =>
        key === "preResponseHandler" ? registered : Reflect.get(target, key),
      set: (target, key, value) => {
        if (!open) return true;
        if (key === "preResponseHandler") registered = value;
        else Reflect.set(target, key, value);
        return true;
      },
    }),
    registered: () => registered !== undefined,
    close: () => {
      open = false;
    },
  };
};

// Product code runs on a fiber of its own, so a fiber it captures never
// becomes the guard's.
const own = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(
    Effect.forkChild(effect, {
      startImmediately: true,
      uninterruptible: "inherit",
    }),
    Fiber.await,
  );

/**
 * `inner` as the response the guard sees, with the whole product lifecycle
 * inside it. Product code runs on a fiber of its own, in a scope of its own
 * that closes before `inner` answers, against a request state of its own. Its
 * failures become their response there and the response's body is read there,
 * so what the guard gets is a value nothing product code holds can change. A
 * pre-response handler registered by then, a finalizer's included, answers
 * Effect's 500; once `inner` answers, the request state takes no writes.
 * Without the request state at Effect's key, a route request answers 500.
 */
const settle = <E, R>(
  inner: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  route: RouteIdentity,
) =>
  Effect.withFiber((fiber) => {
    const state = Context.getOrUndefined(fiber.context, RequestState);
    if (state === undefined) {
      return failed(
        route,
        Cause.die(
          new Error(
            "@confect/server: Effect's request state is not where Confect reads it, so a route request cannot be guarded",
          ),
        ),
      );
    }
    const product = ownRequestState(state);
    return Effect.flatMap(
      own(
        respond(inner, route).pipe(
          Effect.flatMap(materialize),
          Effect.scoped,
          Effect.provideService(RequestState, product.state),
        ),
      ),
      (exit) => {
        product.close();
        if (Exit.isFailure(exit)) return failed(route, exit.cause);
        if (product.registered()) {
          return failed(
            route,
            Cause.die(
              new Error(
                "@confect/server: product code registered a pre-response handler on a route path, where the guard owns the response",
              ),
            ),
          );
        }
        return Effect.succeed(exit.value);
      },
    );
  });

/**
 * The route spec dispatch selects for a request, or `null` for any other route,
 * decided from the same registrations, router configuration and expansion as
 * dispatch and the synthesized OPTIONS chain.
 */
const classifier = (
  registered: ReadonlyArray<Registration>,
  config: Partial<FindMyWay.RouterConfig>,
) => {
  const main = FindMyWay.make<RouteIdentity | null>(config);
  const first = FindMyWay.make<RouteIdentity | null>(config);
  const synthesized = new Map<string, FindMyWay.Router<RouteIdentity | null>>();
  // As Effect's router adds a route, with a wildcard's base path.
  const on = (
    target: FindMyWay.Router<RouteIdentity | null>,
    method: string,
    path: string,
    identity: RouteIdentity | null,
  ) => {
    for (const each of pipe(path, String.endsWith("/*"))
      ? [path, pipe(path, String.slice(0, -2))]
      : [path]) {
      if (method === "*") target.all(each as never, identity);
      else target.on(method, each as never, identity);
    }
  };
  for (const { route, prefix, identity } of registered) {
    const placed =
      prefix === "" ? route : HttpRouter.prefixRoute(route, prefix);
    on(main, route.method, placed.path, identity);
    if (route.method === "OPTIONS" || route.method === "*") continue;
    const candidate =
      synthesized.get(route.method) ??
      FindMyWay.make<RouteIdentity | null>(config);
    synthesized.set(route.method, candidate);
    on(candidate, "OPTIONS", placed.path, identity);
    for (const path of forms(placed.path)) {
      try {
        on(first, "OPTIONS", path, identity);
      } catch {
        // `first` keeps the earliest of equivalent paths, as in `register`.
      }
    }
  }
  return (request: HttpServerRequest.HttpServerRequest) => {
    const { method, url } = request;
    if (method !== "OPTIONS") {
      return (
        (
          main.find(method, url) ??
          (method === "HEAD" ? main.find("GET", url) : undefined)
        )?.handler ?? null
      );
    }
    const explicit = main.find("OPTIONS", url);
    if (explicit !== undefined) return explicit.handler;
    const asked = request.headers["access-control-request-method"];
    const found =
      asked === undefined
        ? first.find("OPTIONS", url)
        : (synthesized.get(asked)?.find("OPTIONS", url) ??
          (asked === "HEAD"
            ? synthesized.get("GET")?.find("OPTIONS", url)
            : undefined));
    return found?.handler ?? null;
  };
};

/**
 * Refuses, before serving, a route spec registration that the api list does not
 * reflect as itself at its own path, an api route spec nothing registers, and
 * an explicit OPTIONS or any-method route that could answer a route spec's
 * request.
 */
const checkRegistrations = (
  registered: ReadonlyArray<Registration>,
  { guard, reflected, mount }: Admission,
) =>
  Effect.gen(function* () {
    const specs = Arr.filter(registered, ({ identity }) => identity !== null);
    const [firstSpec] = specs;
    if (firstSpec === undefined && reflected.size === 0) return;
    if (guard === undefined) {
      return yield* Effect.die(
        Guard.MissingGuard.make({
          functionPath: (firstSpec?.identity ?? [...reflected.values()][0]!)
            .functionPath,
        }),
      );
    }
    const prefix = yield* mount;
    const unserved = new Map(reflected);
    for (const { route, prefix: placedUnder, identity } of specs) {
      const key = `${route.method} ${route.path}`;
      const at = reflected.get(key);
      const problem =
        at === undefined
          ? "notReflected"
          : at.functionPath !== identity!.functionPath ||
              at.spec !== identity!.spec
            ? "mismatched"
            : placedUnder !== prefix
              ? "prefixed"
              : undefined;
      if (problem !== undefined) {
        return yield* Effect.die(
          Guard.UnreflectedRoute.make({
            functionPath: identity!.functionPath,
            problem,
          }),
        );
      }
      unserved.delete(key);
    }
    const [notServed] = unserved.values();
    if (notServed !== undefined) {
      return yield* Effect.die(
        Guard.UnreflectedRoute.make({
          functionPath: notServed.functionPath,
          problem: "notServed",
        }),
      );
    }
    const patterns = Arr.map(
      specs,
      ({ route, prefix: placedUnder, identity }) => ({
        identity: identity!,
        pattern: RouteOverlap.effectPattern(
          placedUnder === ""
            ? route.path
            : HttpRouter.prefixRoute(route, placedUnder).path,
        ),
      }),
    );
    for (const { route, prefix: placedUnder, identity } of registered) {
      if (identity !== null) continue;
      if (route.method !== "OPTIONS" && route.method !== "*") continue;
      const path =
        placedUnder === ""
          ? route.path
          : HttpRouter.prefixRoute(route, placedUnder).path;
      const pattern = RouteOverlap.effectPattern(path);
      const shadowed = Arr.findFirst(patterns, (spec) =>
        RouteOverlap.overlap(pattern, spec.pattern),
      );
      if (Option.isSome(shadowed)) {
        return yield* Effect.die(
          Guard.RouteShadowed.make({
            method: route.method,
            path,
            functionPath: shadowed.value.identity.functionPath,
          }),
        );
      }
    }
  });

/**
 * @internal
 */
export const withOptions = <A, E, R>(
  routes: Layer.Layer<A, E, R>,
  endpoints: ReadonlySet<string>,
  admission: Admission,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const config = yield* HttpRouter.RouterConfig;
      const { guard } = admission;
      const registered: Array<Registration> = [];
      let classify: (
        request: HttpServerRequest.HttpServerRequest,
      ) => RouteIdentity | null = () => null;
      // The gate is the router's first global middleware, so it encloses every
      // later global middleware, router-scoped middleware and endpoint chain.
      if (guard !== undefined) {
        yield* router.addGlobalMiddleware(((
          inner: Effect.Effect<HttpServerResponse.HttpServerResponse>,
        ) =>
          Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
            const route = classify(request);
            return route === null
              ? inner
              : guard(settle(inner, route)).pipe(
                  Effect.provideService(Routes.Route, route),
                  Effect.provideService(
                    Guard.Preflight,
                    request.method === "OPTIONS",
                  ),
                  Effect.provideService(Admitted, route),
                );
          })) as never);
      }
      // A product global middleware may replace the request before dispatch.
      // The request it hands on must still be the route the guard admitted.
      const unchanged = <E1, R1>(
        inner: Effect.Effect<HttpServerResponse.HttpServerResponse, E1, R1>,
      ) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const admitted = yield* Admitted;
          if (classify(request) !== admitted) {
            return yield* Effect.die(
              new Error(
                `@confect/server: a global middleware changed ${request.method} ${request.url} into another route after the guard ran`,
              ),
            );
          }
          return yield* inner;
        });
      const wrap = (
        target: HttpRouter.HttpRouter,
        prefix: string,
      ): HttpRouter.HttpRouter => {
        const addAll: HttpRouter.HttpRouter["addAll"] = (entries) =>
          Effect.contextWith((context: Context.Context<never>) => {
            for (const route of entries)
              registered.push({
                route,
                prefix,
                context,
                identity: identities.get(route) ?? null,
              });
            return target.addAll(entries);
          });
        return HttpRouter.HttpRouter.of({
          ...target,
          addAll,
          ...(guard === undefined
            ? {}
            : {
                addGlobalMiddleware: (middleware) =>
                  target.addGlobalMiddleware(((
                    inner: Effect.Effect<HttpServerResponse.HttpServerResponse>,
                  ) => middleware(unchanged(inner) as never)) as never),
              }),
          add: (method, path, handler, options) =>
            addAll([HttpRouter.route(method, path, handler, options)]),
          prefixed: (next) =>
            wrap(
              target.prefixed(next),
              `${prefix}${pipe(next, String.replace(/\/$/, ""))}`,
            ),
        });
      };
      const register = Effect.gen(function* () {
        yield* checkRegistrations(registered, admission);
        if (guard !== undefined) classify = classifier(registered, config);
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
          // Split the prefixed path: an optional parameter may sit in the prefix.
          const placed =
            prefix === "" ? copy : HttpRouter.prefixRoute(copy, prefix);
          for (const path of forms(placed.path)) {
            const form = first.addAll([{ ...placed, path }]);
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
