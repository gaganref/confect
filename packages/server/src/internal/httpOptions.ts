import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as References from "effect/References";
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

/**
 * A route response as plain data, the only thing that crosses from product code
 * to the guard. Confect builds the response the guard sees from it.
 */
interface Snapshot {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  readonly body: Uint8Array;
  readonly contentType: string;
}

/**
 * What product code hands the guard: its response, and the failure to log as
 * text when that response is a server error.
 */
interface Answer {
  readonly response: Snapshot;
  readonly failure: string | undefined;
}

// The design's result cap: a response body larger than this answers 500.
const resultCap = 1024 * 1024;
// A logged failure's text stops at this many characters, its ellipsis included.
const failureCap = 8 * 1024;

const internalError: Snapshot = Object.freeze({
  status: 500,
  headers: Object.freeze([]),
  body: new Uint8Array(0),
  contentType: "",
});

const capped = (text: string) =>
  text.length > failureCap
    ? `${pipe(text, String.slice(0, failureCap - 1))}…`
    : text;

// Every refusal's failure text passes through here, so none logs past the cap.
const refusal = (failure: string): Answer =>
  Object.freeze({ response: internalError, failure: capped(failure) });

// Product-owned values in a cause, such as an error's stack, can run product
// code when read, so a cause is read only on the product's fiber. One that
// throws there ends that fiber, which answers 500 with a fixed failure.
const describe = (cause: Cause.Cause<unknown>) =>
  cause.pipe(Cause.pretty, capped);

/**
 * Bytes read so far, kept until they pass the result cap.
 */
const collector = () => {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  return {
    /**
     * Keeps a chunk, and answers whether reading may go on.
     */
    add: (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > resultCap) return false;
      chunks.push(chunk);
      return true;
    },
    over: () => size > resultCap,
    bytes: () => {
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      return bytes;
    },
  };
};

type Collector = ReturnType<typeof collector>;

const readWeb = (body: ReadableStream<Uint8Array>, into: Collector) =>
  Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.gen(function* () {
        while (true) {
          const { done, value } = yield* Effect.promise(() => reader.read());
          if (done || !into.add(value)) return;
        }
      }),
    (reader) => Effect.ignoreCause(Effect.promise(() => reader.cancel())),
  );

// Headers a snapshot carries elsewhere, or that its body decides.
const unsnapshotted = new Set(["content-type", "content-length", "set-cookie"]);

const overCap = `@confect/server: a route response's body is larger than the ${resultCap}-byte result cap`;

// A cookie's value can be a secret, so the failure names the cookie alone.
const repeatedCookie = (name: string) =>
  `@confect/server: a route response sets the cookie "${name}" more than once. Effect keys a response's cookies by name, so a guard's edit by that name would miss one of them`;

/**
 * The response as Effect would send it, read into a snapshot, or the failure
 * that refuses it: a body past the result cap, with the rest left unread, or a
 * cookie name set twice, which the response the guard sees cannot hold. A
 * stream body runs here, on the product's fiber and in its scope.
 */
const snapshotOf = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    let flat = response;
    if (response.body._tag === "Stream") {
      const { stream, contentType } = response.body;
      const streamed = collector();
      yield* Stream.runForEachWhile(stream, (chunk) =>
        Effect.sync(() => streamed.add(chunk)),
      );
      if (streamed.over()) return overCap;
      flat = HttpServerResponse.setBody(
        response,
        HttpBody.uint8Array(streamed.bytes(), contentType),
      );
    }
    const sent = HttpServerResponse.toWeb(flat);
    const read = collector();
    if (sent.body !== null) yield* readWeb(sent.body, read);
    if (read.over()) return overCap;
    const headers: Array<readonly [string, string]> = [];
    sent.headers.forEach((value, name) => {
      if (!unsnapshotted.has(name)) headers.push(Object.freeze([name, value]));
    });
    const named = new Set<string>();
    for (const header of sent.headers.getSetCookie()) {
      for (const { name } of Record.values(
        Cookies.fromSetCookie(header).cookies,
      )) {
        if (named.has(name)) return repeatedCookie(name);
        named.add(name);
      }
      headers.push(Object.freeze(["set-cookie", header]));
    }
    const snapshot: Snapshot = Object.freeze({
      status: sent.status,
      headers: Object.freeze(headers),
      body: read.bytes(),
      contentType: sent.headers.get("content-type") ?? "",
    });
    return snapshot;
  });

const toResponse = ({ status, headers, body, contentType }: Snapshot) => {
  const plain: Array<readonly [string, string]> = [];
  const setCookie: Array<string> = [];
  for (const [name, value] of headers) {
    if (name === "set-cookie") setCookie.push(value);
    else plain.push([name, value]);
  }
  const options = {
    status,
    headers: Headers.fromInput(plain),
    cookies: Cookies.fromSetCookie(setCookie),
  };
  return body.byteLength === 0 && contentType === ""
    ? HttpServerResponse.empty(options)
    : HttpServerResponse.uint8Array(body, {
        ...options,
        contentType: contentType === "" ? undefined : contentType,
      });
};

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
 * Logs a route request's server failure at error level: its text, the request
 * id and the route's function path, and no annotation or span of the request,
 * since no response carries its cause. A logger that fails is ignored, so the
 * guard still gets its 500.
 */
const report = (route: RouteIdentity, failure: string) =>
  Effect.flatMap(currentRequestId, (requestId) =>
    Effect.logError(failure).pipe(
      Effect.provideService(References.CurrentLogAnnotations, {
        ...(requestId === undefined ? {} : { requestId }),
        functionPath: route.functionPath,
      }),
      Effect.provideService(References.CurrentLogSpans, []),
    ),
  ).pipe(Effect.ignoreCause);

const answered = (route: RouteIdentity, { response, failure }: Answer) =>
  Effect.as(
    failure === undefined ? Effect.void : report(route, failure),
    toResponse(response),
  );

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

/**
 * `inner` as product code answers it, on the product's fiber: its failure
 * becomes its response, its body is read, and its scope closes, all before the
 * answer leaves. A cause is turned into text here too.
 */
const answer = <E, R>(
  inner: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  inner.pipe(
    Effect.map((response) => ({ response, failure: undefined })),
    Effect.catchCause((cause) =>
      Effect.suspend(() => HttpServerError.causeResponse(cause)).pipe(
        Effect.map(([response]) => ({
          response,
          failure: response.status >= 500 ? describe(cause) : undefined,
        })),
      ),
    ),
    Effect.flatMap(({ response, failure }) =>
      Effect.map(snapshotOf(response), (snapshot): Answer =>
        typeof snapshot === "string"
          ? refusal(snapshot)
          : Object.freeze({ response: snapshot, failure }),
      ),
    ),
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.sync(() => cause.pipe(describe, refusal)),
    ),
  );

/**
 * The guard's own copy of an answer. The product fiber's result stays within
 * product code's reach, through a completion observer for one, so the guard
 * copies the body as the answer arrives and reads nothing of the result after.
 */
const guardOwned = ({ response, failure }: Answer): Answer =>
  Object.freeze({
    response: Object.freeze({
      ...response,
      body: new Uint8Array(response.body),
    }),
    failure,
  });

/**
 * `inner` as the response the guard sees, with the whole product lifecycle
 * inside it. Product code runs on a fiber of its own, started from a context
 * whose request state is a stand-in, so neither its context nor any context it
 * restores holds the real one. The fiber starts from Effect's scheduler, never
 * inside the guard's fiber, so `Fiber.getCurrent` in product code never returns
 * the guard's fiber. The guard observes the fiber's end before product code
 * can, and closes the stand-in first: a pre-response handler registered until
 * then, by an interrupted child fiber's finalizer for one, answers 500, and one
 * registered later, by a completion observer for one, lands nowhere. Only a
 * frozen snapshot of plain data comes back, and the guard's response is built
 * from its own copy of it.
 */
const settle = <E, R>(
  inner: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  route: RouteIdentity,
) =>
  Effect.withFiber((fiber) => {
    const state = Context.getOrUndefined(fiber.context, RequestState);
    if (state === undefined) {
      return answered(
        route,
        refusal(
          "@confect/server: Effect's request state is not where Confect reads it, so a route request cannot be guarded",
        ),
      );
    }
    const standIn = ownRequestState(state);
    return Effect.forkChild(answer(inner), {
      startImmediately: false,
      uninterruptible: "inherit",
    }).pipe(
      Effect.provideService(RequestState, standIn.state),
      Effect.flatMap(Fiber.await),
      Effect.flatMap((exit) => {
        standIn.close();
        return answered(
          route,
          Exit.isFailure(exit)
            ? refusal(
                "@confect/server: product code on a route path ended without an answer",
              )
            : standIn.registered()
              ? refusal(
                  "@confect/server: product code registered a pre-response handler on a route path, where the guard owns the response",
                )
              : guardOwned(exit.value),
        );
      }),
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
                "@confect/server: a global middleware changed the request into another route after the guard ran",
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
