import * as IdScope from "@confect/core/IdScope";
import { FunctionSpec, GroupSpec, MiddlewareSpec } from "@confect/core";
import {
  ActionCtx,
  DatabaseSchema,
  FunctionImpl,
  Guard,
  GroupImpl,
  HttpRouter as ConfectHttpRouter,
  MiddlewareImpl,
  Routes,
} from "@confect/server";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { convexTest } from "convex-test";
import { httpActionGeneric, type GenericDataModel } from "convex/server";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import schema from "./mock-backend/fixtures/confect/_generated/schema";
import { RequestState, withOptions } from "../src/internal/httpOptions";
import { identities } from "../src/internal/routeIdentity";

const log: Array<string> = [];

class Admitted extends Context.Service<
  Admitted,
  { readonly principal: string }
>()("@confect/server/test/Guard.test/Admitted") {}

const seen = (who: string) =>
  Effect.map(Effect.serviceOption(Admitted), (admitted) => {
    log.push(`${who}:${Option.isSome(admitted) ? "admitted" : "bare"}`);
  });

class Nope extends Schema.TaggedError<
  Nope,
  { readonly brand: unique symbol }
>()("Nope", {}, { httpApiStatus: 422 }) {}

class Trace extends MiddlewareSpec.MiddlewareSpec<Trace>()("Trace", {
  functionTypes: { query: true, mutation: true, action: true },
}) {}

const route = <const Name extends string, const Path extends string>(
  name: Name,
  method: FunctionSpec.HttpMethod,
  path: Path,
) =>
  FunctionSpec.httpAction({
    name,
    method,
    path: path as never,
    args: () => ({ id: Schema.optional(Schema.String) }),
    returns: () => Schema.String,
  });

const notes = GroupSpec.make()
  .middleware(Trace)
  .addFunction(
    FunctionSpec.httpAction({
      name: "write",
      method: "POST",
      path: "/write",
      args: () => ({ n: Schema.Finite }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.httpAction({
      name: "read",
      method: "GET",
      path: "/notes/:id",
      args: () => ({ id: Schema.String }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.httpAction({
      name: "bad",
      method: "GET",
      path: "/bad",
      returns: () => Schema.Finite,
    }),
  )
  .addFunction(
    FunctionSpec.httpAction({
      name: "nope",
      method: "GET",
      path: "/nope",
      returns: () => Schema.String,
      error: () => Nope,
    }),
  )
  .addFunction(route("boom", "GET", "/boom"))
  .addFunction(
    FunctionSpec.httpAction({
      name: "asset",
      method: "GET",
      path: "/assets/:id",
      args: () => ({ id: Schema.String }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.httpAction({
      name: "head",
      method: "GET",
      path: "/head/:id",
      args: () => ({ id: Schema.String }),
      returns: () => Schema.String,
    }),
  );

const notesImpl = GroupImpl.make(schema, notes).pipe(
  Layer.provide(
    FunctionImpl.make(schema, notes, "write", ({ n }) =>
      Effect.as(seen("handler"), `n=${n}`),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "read", ({ id }) =>
      Effect.as(seen("handler"), `id=${id}`),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "bad", () =>
      Effect.as(seen("handler"), "not a number" as unknown as number),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "nope", () =>
      Effect.andThen(seen("handler"), Effect.fail(Nope.make({}))),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "boom", () =>
      Effect.andThen(seen("handler"), Effect.die(new Error("boom"))),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "asset", ({ id }) =>
      Effect.as(seen("handler"), `asset=${id}`),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "head", ({ id }) =>
      Effect.as(seen("handler"), `head=${id}`),
    ),
  ),
  Layer.provide(
    MiddlewareImpl.make(schema, Trace, (effect) =>
      Effect.andThen(seen("function"), effect),
    ),
  ),
  GroupImpl.finalize,
);

const routes = Routes.make(schema, { notes: [notes, notesImpl] });

class ApiMw extends HttpApiMiddleware.Service<ApiMw>()("test/Guard/ApiMw") {}
class GroupMw extends HttpApiMiddleware.Service<GroupMw>()(
  "test/Guard/GroupMw",
) {}

const ProductApi = HttpApi.make("product")
  .add(
    HttpApiGroup.make("plain")
      .add(HttpApiEndpoint.get("plain", "/plain", { success: Schema.String }))
      .add(
        HttpApiEndpoint.head("head", "/head/:id", {
          params: { id: Schema.String },
        }),
      )
      .middleware(GroupMw),
  )
  .middleware(ApiMw);

const product = HttpApiBuilder.layer(ProductApi).pipe(
  Layer.provide(
    HttpApiBuilder.group(ProductApi, "plain", (handlers) =>
      handlers
        .handle("plain", () => Effect.as(seen("handler"), "plain"))
        .handle("head", () => seen("product")),
    ),
  ),
  Layer.provide([
    Layer.succeed(GroupMw, (effect) => Effect.andThen(seen("group"), effect)),
    Layer.succeed(ApiMw, (effect) => Effect.andThen(seen("api"), effect)),
  ]),
);

const text = (who: string, body: string) =>
  Effect.as(seen(who), HttpServerResponse.text(body));

const productRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/notes/special", text("product", "special")),
  HttpRouter.add("POST", "/notes/:id", text("product", "post")),
  HttpRouter.add("GET", "/assets/*", text("product", "assets")),
  HttpRouter.add("GET", "/opt/:a?", text("product", "opt")),
);

const GlobalMw = HttpRouter.middleware(
  (effect) => Effect.andThen(seen("global"), effect),
  { global: true },
);

// A later global middleware that rewrites the request URL from a header.
const Rewrite = HttpRouter.middleware(
  (effect) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const url = request.headers["x-rewrite"];
      return url === undefined
        ? effect
        : Effect.provideService(
            effect,
            HttpServerRequest.HttpServerRequest,
            request.modify({ url }),
          );
    }),
  { global: true },
);

const RouterMw = HttpRouter.middleware((effect) =>
  Effect.andThen(seen("router"), effect),
).layer;

const app = Layer.mergeAll(
  routes.routes.pipe(Layer.provide(RouterMw)),
  product.pipe(Layer.provide(RouterMw)),
  productRoutes,
  Rewrite,
  GlobalMw,
);

const cors = HttpServerResponse.setHeader(
  "access-control-allow-origin",
  "https://app.test",
);

const frame = Guard.make("frame", (inner) =>
  Effect.gen(function* () {
    const { functionPath } = yield* Routes.Route;
    const preflight = yield* Guard.Preflight;
    log.push(`guard:${functionPath}${preflight ? ":preflight" : ""}`);
    if (preflight) return HttpServerResponse.empty({ status: 204 });
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers["authorization"];
    if (authorization !== undefined && authorization !== "Bearer good") {
      return HttpServerResponse.empty({ status: 401 });
    }
    const response = yield* Effect.provideService(inner, Admitted, {
      principal: authorization === undefined ? "Public" : "Person",
    });
    log.push(`settle:${response.status}`);
    return response;
  }).pipe(Effect.map(cors)),
);

type Router = ReturnType<typeof ConfectHttpRouter.make>;

const serve = (router: Router) => {
  const t = convexTest(undefined, {
    ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
    "./mock-backend/fixtures/convex/http.ts": () =>
      Promise.resolve({ default: router }),
  });
  return (
    path: string,
    init: {
      readonly method?: string;
      readonly headers?: Record<string, string>;
      readonly body?: string;
    } = {},
  ) =>
    Effect.gen(function* () {
      log.length = 0;
      const response = yield* Effect.promise(() => t.fetch(path, init));
      const body = yield* Effect.promise(() => response.text());
      return {
        status: response.status,
        statusText: response.statusText,
        cors: response.headers.get("access-control-allow-origin"),
        headers: Rec.fromEntries([...response.headers]),
        cookies: response.headers.getSetCookie(),
        body,
        log: [...log],
      };
    });
};

const make = (
  layer: ConfectHttpRouter.Routes<typeof schema>,
  options: Parameters<typeof ConfectHttpRouter.make>[2],
) => ConfectHttpRouter.make(schema, layer, options);

// Under convex-test a router that refuses to build rejects every request,
// and no product code runs.
const refusedBeforeServing = (router: Router, refusal: string) =>
  Effect.gen(function* () {
    const refused = serve(router);
    for (const path of ["/notes/1", "/plain"]) {
      const exit = yield* Effect.exit(refused(path));
      expect(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit.value,
      ).toMatchObject({ _tag: refusal });
      expect(log).toEqual([]);
    }
  });

const apis = [ProductApi, routes.api] as const;
const send = serve(make(app, { api: apis, guard: frame }));
const json = { "content-type": "application/json" };

describe("the guard encloses every request middleware on a route path", () => {
  it.effect(
    "a refused bearer with malformed JSON stops at the guard; no global, router or function middleware runs",
    () =>
      Effect.gen(function* () {
        const answer = yield* send("/write", {
          method: "POST",
          headers: { ...json, authorization: "Bearer bad" },
          body: "{x",
        });
        expect(answer).toMatchObject({
          status: 401,
          cors: "https://app.test",
          log: ["guard:notes:write"],
        });
      }),
  );

  it.effect(
    "an admitted request runs global, router and function middleware inside the guard, then settles",
    () =>
      Effect.gen(function* () {
        const answer = yield* send("/write", {
          method: "POST",
          headers: { ...json, authorization: "Bearer good" },
          body: '{"n":1}',
        });
        expect(answer).toMatchObject({
          status: 200,
          cors: "https://app.test",
          body: '"n=1"',
          log: [
            "guard:notes:write",
            "global:admitted",
            "router:admitted",
            "function:admitted",
            "handler:admitted",
            "settle:200",
          ],
        });
      }),
  );

  it.effect("HEAD runs GET's route spec under the guard", () =>
    Effect.gen(function* () {
      const answer = yield* send("/notes/7", { method: "HEAD" });
      expect(answer.log[0]).toBe("guard:notes:read");
    }),
  );

  it.effect("a preflight is the guard's alone", () =>
    Effect.gen(function* () {
      const answer = yield* send("/write", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.test",
          "access-control-request-method": "POST",
        },
      });
      expect(answer).toMatchObject({
        status: 204,
        cors: "https://app.test",
        log: ["guard:notes:write:preflight"],
      });
    }),
  );

  it.effect(
    "a product route that shadows a route spec's parameter is classified as the router dispatches it",
    () =>
      Effect.gen(function* () {
        const special = yield* send("/notes/special");
        const spec = yield* send("/notes/x");
        expect([special.log, spec.log[0]]).toEqual([
          ["global:bare", "product:bare"],
          "guard:notes:read",
        ]);
      }),
  );

  it.effect("a hand-written endpoint passes the guard by", () =>
    Effect.gen(function* () {
      const answer = yield* send("/plain");
      expect(answer.log).toEqual([
        "global:bare",
        "router:bare",
        "api:bare",
        "group:bare",
        "handler:bare",
      ]);
    }),
  );

  it.effect(
    "the guard sees the encoded response: a result that breaks its schema settles as 500",
    () =>
      Effect.gen(function* () {
        const answer = yield* send("/bad");
        expect(answer).toMatchObject({ status: 500, cors: "https://app.test" });
        expect(answer.log.at(-1)).toBe("settle:500");
      }),
  );

  it.effect(
    "a declared error settles under its declared status, and a defect as 500, both with CORS",
    () =>
      Effect.gen(function* () {
        const nope = yield* send("/nope");
        const boom = yield* send("/boom");
        expect([nope, boom]).toMatchObject([
          { status: 422, cors: "https://app.test" },
          { status: 500, cors: "https://app.test" },
        ]);
        expect([nope.log.at(-1), boom.log.at(-1)]).toEqual([
          "settle:422",
          "settle:500",
        ]);
      }),
  );

  it.effect(
    "a payload that fails its schema settles as 400 inside the guard",
    () =>
      Effect.gen(function* () {
        const answer = yield* send("/write", {
          method: "POST",
          headers: json,
          body: '{"n":"x"}',
        });
        expect(answer.log.at(-1)).toBe("settle:400");
      }),
  );
});

describe("a route needs an explicit guard", () => {
  it("route specs with no guard refuse to build the router", () => {
    expect(() => make(app, { api: apis })).toThrow(
      expect.objectContaining({
        _tag: "MissingGuard",
        functionPath: "notes:write",
      }),
    );
  });

  it("a route-only backend refuses too", () => {
    expect(() => make(routes.routes, { api: routes.api })).toThrow(
      expect.objectContaining({ _tag: "MissingGuard" }),
    );
  });

  it("a component backend refuses too", () => {
    const component = DatabaseSchema.make(
      {},
      { kind: "component", scope: IdScope.component("notes") },
    );
    expect(() =>
      ConfectHttpRouter.make(component, routes.routes as never, {
        api: routes.api,
      }),
    ).toThrow(expect.objectContaining({ _tag: "MissingGuard" }));
  });

  it.effect("Guard.none serves route specs with no gate", () =>
    Effect.gen(function* () {
      const open = serve(make(app, { api: apis, guard: Guard.none }));
      const answer = yield* open("/notes/1");
      expect(answer).toMatchObject({
        status: 200,
        log: ["global:bare", "router:bare", "function:bare", "handler:bare"],
      });
    }),
  );

  it.effect(
    "omitting the api list cannot make a spec ordinary, with or without a guard",
    () =>
      Effect.gen(function* () {
        yield* refusedBeforeServing(make(app, {}), "MissingGuard");
        yield* refusedBeforeServing(
          make(app, { guard: frame }),
          "UnreflectedRoute",
        );
      }),
  );

  it.effect("a partial api list refuses before serving", () =>
    refusedBeforeServing(
      make(app, { api: [ProductApi], guard: frame }),
      "UnreflectedRoute",
    ),
  );

  it.effect(
    "an endpoint annotated as a route that Routes.make did not register refuses before serving",
    () =>
      Effect.gen(function* () {
        const ForgedApi = HttpApi.make("forged").add(
          HttpApiGroup.make("forged").add(
            HttpApiEndpoint.get("forged", "/forged", {
              success: Schema.String,
            }).annotate(Routes.Route, {
              functionPath: "notes:read",
              spec: notes.functions.read,
            }),
          ),
        );
        const forged = HttpApiBuilder.layer(ForgedApi).pipe(
          Layer.provide(
            HttpApiBuilder.group(ForgedApi, "forged", (handlers) =>
              handlers.handle("forged", () => Effect.as(seen("forged"), "x")),
            ),
          ),
        );
        yield* refusedBeforeServing(
          make(Layer.merge(app, forged), {
            api: [...apis, ForgedApi],
            guard: frame,
          }),
          "UnreflectedRoute",
        );
      }),
  );

  it.effect("a route spec under a product prefix refuses before serving", () =>
    Effect.gen(function* () {
      const prefixed = routes.routes.pipe(
        Layer.provide(
          Layer.effect(
            HttpRouter.HttpRouter,
            Effect.map(HttpRouter.HttpRouter, (router) =>
              router.prefixed("/v1"),
            ),
          ),
        ),
      );
      yield* refusedBeforeServing(
        make(Layer.merge(prefixed, product), { api: apis, guard: frame }),
        "UnreflectedRoute",
      );
    }),
  );
});

describe("classification picks the spec dispatch picks", () => {
  it.effect(
    "the guard owns OPTIONS on a route path with or without Access-Control-Request-Method",
    () =>
      Effect.gen(function* () {
        const bare = yield* send("/write", { method: "OPTIONS" });
        const asked = yield* send("/notes/1", {
          method: "OPTIONS",
          headers: { "access-control-request-method": "GET" },
        });
        expect([bare, asked]).toMatchObject([
          { status: 204, log: ["guard:notes:write:preflight"] },
          { status: 204, log: ["guard:notes:read:preflight"] },
        ]);
      }),
  );

  it.effect(
    "a preflight for a product route's method at a route path is not the guard's",
    () =>
      Effect.gen(function* () {
        const answer = yield* send("/notes/1", {
          method: "OPTIONS",
          headers: { "access-control-request-method": "POST" },
        });
        expect(answer.log).toEqual(["global:bare"]);
      }),
  );

  it.effect("an explicit HEAD route takes HEAD before GET's route spec", () =>
    Effect.gen(function* () {
      const head = yield* send("/head/1", { method: "HEAD" });
      const get = yield* send("/head/1");
      expect([head.log.at(-1), head.log[0], get.log[0]]).toEqual([
        "product:bare",
        "global:bare",
        "guard:notes:head",
      ]);
    }),
  );

  it.effect("a wildcard and its base stay the product's", () =>
    Effect.gen(function* () {
      const spec = yield* send("/assets/x");
      const nested = yield* send("/assets/x/y");
      const base = yield* send("/assets");
      expect([spec.log[0], nested.log, base.log]).toEqual([
        "guard:notes:asset",
        ["global:bare", "product:bare"],
        ["global:bare", "product:bare"],
      ]);
    }),
  );

  it.effect("an optional parameter's forms stay the product's", () =>
    Effect.gen(function* () {
      const short = yield* send("/opt");
      const long = yield* send("/opt/1");
      expect([short.log, long.log]).toEqual([
        ["global:bare", "product:bare"],
        ["global:bare", "product:bare"],
      ]);
    }),
  );

  it.effect(
    "odd slashes and encoded characters classify as dispatch does",
    () =>
      Effect.gen(function* () {
        const slashes = yield* send("//notes//7/");
        const encoded = yield* send("/notes/%61");
        expect(
          Arr.map([slashes, encoded], ({ status, body, log: [first] }) => [
            status,
            body,
            first,
          ]),
        ).toEqual([
          [200, '"id=7"', "guard:notes:read"],
          [200, '"id=a"', "guard:notes:read"],
        ]);
      }),
  );

  it.effect(
    "a malformed path or an over-long parameter matches nothing, so no route code runs",
    () =>
      Effect.gen(function* () {
        const malformed = yield* send("/notes/%E0%A4%A");
        const long = yield* send(`/notes/${pipe("x", Str.repeat(101))}`);
        expect([malformed, long]).toMatchObject([
          { status: 404, log: ["global:bare"] },
          { status: 404, log: ["global:bare"] },
        ]);
      }),
  );

  it.effect(
    "a request rewritten after the guard cannot reach another route",
    () =>
      Effect.gen(function* () {
        const intoSpec = yield* send("/plain", {
          headers: { "x-rewrite": "/notes/7" },
        });
        const outOfSpec = yield* send("/notes/7", {
          headers: { "x-rewrite": "/notes/special" },
        });
        const productCode = (entries: ReadonlyArray<string>) =>
          Arr.filter(
            entries,
            (entry) => !pipe(entry, Str.startsWith("global:")),
          );
        expect([intoSpec.status, outOfSpec.status]).toEqual([500, 500]);
        expect([productCode(intoSpec.log), productCode(outOfSpec.log)]).toEqual(
          [[], ["guard:notes:read", "settle:500"]],
        );
      }),
  );

  it.effect(
    "an explicit OPTIONS or any-method route at a route path refuses before serving",
    () =>
      Effect.gen(function* () {
        for (const conflict of [
          HttpRouter.add("OPTIONS", "/notes/:id", text("product", "options")),
          HttpRouter.add("*", "/notes/*", text("product", "any")),
        ]) {
          yield* refusedBeforeServing(
            make(Layer.merge(app, conflict), { api: apis, guard: frame }),
            "RouteShadowed",
          );
        }
      }),
  );
});

describe("a plain Convex route cannot take a route spec's path", () => {
  const router = () => make(app, { api: apis, guard: frame });
  const handler = httpActionGeneric(() => Promise.resolve(new Response("raw")));
  it.each([
    { path: "/write", method: "POST" },
    { path: "/notes/anything", method: "GET" },
    { path: "/Notes/7", method: "GET" },
    { path: "/notes/%41", method: "GET" },
    { path: "/write", method: "OPTIONS" },
    { pathPrefix: "/notes/", method: "GET" },
    { pathPrefix: "/notes/7/", method: "GET" },
  ] as const)("refuses $method $path$pathPrefix", (spec) => {
    expect(() => router().route({ ...spec, handler })).toThrow(
      expect.objectContaining({ _tag: "RouteShadowed" }),
    );
  });
  it.effect.each([
    { method: "POST", raw: { path: "/webhooks/raw" }, at: "/webhooks/raw" },
    { method: "GET", raw: { path: "/write" }, at: "/write" },
    { method: "GET", raw: { path: "/notes/7/more" }, at: "/notes/7/more" },
    { method: "POST", raw: { pathPrefix: "/webhooks/" }, at: "/webhooks/x" },
  ] as const)(
    "keeps a raw $method route that serves $at",
    ({ method, raw, at }) =>
      Effect.gen(function* () {
        const kept = router();
        kept.route({ ...raw, method, handler });
        const answer = yield* serve(kept)(at, { method });
        expect(answer).toMatchObject({ status: 200, body: "raw", log: [] });
      }),
  );
});

describe("the guard is a plain HttpMiddleware", () => {
  it("types as one", () => {
    expectTypeOf(frame).toExtend<HttpMiddleware.HttpMiddleware>();
    expect(frame.name).toBe("frame");
    expect(Guard.none.name).toBe("none");
  });

  it.effect(
    "Effect's own cors middleware runs as a guard on route paths only",
    () =>
      Effect.gen(function* () {
        const guarded = serve(
          make(app, {
            api: apis,
            guard: Guard.make(
              "cors",
              HttpMiddleware.cors({ allowedOrigins: ["https://app.test"] }),
            ),
          }),
        );
        const spec = yield* guarded("/notes/1", {
          headers: { origin: "https://app.test" },
        });
        const special = yield* guarded("/notes/special", {
          headers: { origin: "https://app.test" },
        });
        expect([spec.cors, special.cors]).toEqual(["https://app.test", null]);
      }),
  );

  it.effect(
    "a guard that fails answers Effect's response for the failure",
    () =>
      Effect.gen(function* () {
        const failing = serve(
          make(app, {
            api: apis,
            guard: Guard.make("failing", () => Effect.die(new Error("down"))),
          }),
        );
        const answer = yield* failing("/notes/1");
        expect(answer).toMatchObject({ status: 500, log: [] });
      }),
  );
});

describe("a plain Convex route waits for the router to admit its registrations", () => {
  const raw = (body: string) =>
    httpActionGeneric(() => {
      log.push(`raw:${body}`);
      return Promise.resolve(new Response(body));
    });

  it.effect(
    "with the api list omitted or partial, no raw route serves, overlapping or not",
    () =>
      Effect.gen(function* () {
        for (const [options, refusal] of [
          [{}, "MissingGuard"],
          [{ guard: frame }, "UnreflectedRoute"],
          [{ api: [ProductApi], guard: frame }, "UnreflectedRoute"],
        ] as const) {
          const router = make(app, options);
          router.route({
            path: "/notes/raw",
            method: "GET",
            handler: raw("overlap"),
          });
          router.route({
            path: "/webhooks/raw",
            method: "POST",
            handler: raw("plain"),
          });
          const refused = serve(router);
          for (const [path, method] of [
            ["/notes/raw", "GET"],
            ["/webhooks/raw", "POST"],
            ["/notes/1", "GET"],
          ] as const) {
            const exit = yield* Effect.exit(refused(path, { method }));
            expect(
              Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit.value,
            ).toMatchObject({ _tag: refusal });
            expect(log).toEqual([]);
          }
        }
      }),
  );

  it.effect(
    "a router that admits its registrations serves its raw routes",
    () =>
      Effect.gen(function* () {
        const router = make(app, { api: apis, guard: frame });
        router.route({
          path: "/webhooks/raw",
          method: "POST",
          handler: raw("plain"),
        });
        const answer = yield* serve(router)("/webhooks/raw", {
          method: "POST",
        });
        expect(answer).toMatchObject({
          status: 200,
          body: "plain",
          log: ["raw:plain"],
        });
      }),
  );
});

describe("a product pre-response handler on a route path answers 500", () => {
  const latest = (response: HttpServerResponse.HttpServerResponse) =>
    Effect.sync(() => {
      log.push("callback");
      return response;
    });
  const late = () =>
    Effect.sync(() => {
      log.push("late");
      return HttpServerResponse.text("late", { status: 419 });
    });
  const registering = (
    register: (
      context: Context.Context<never>,
    ) => Effect.Effect<void, never, HttpServerRequest.HttpServerRequest>,
  ) =>
    HttpRouter.middleware(
      (inner) =>
        Effect.withFiber((fiber) =>
          Effect.andThen(register(fiber.context), inner),
        ),
      { global: true },
    );

  it.effect(
    "a handler that registers another handler never runs, and the guard settles Effect's 500",
    () =>
      Effect.gen(function* () {
        const nesting = registering((context) =>
          HttpEffect.appendPreResponseHandler((_, response) => {
            log.push("callback");
            HttpEffect.appendPreResponseHandlerUnsafe(context, late);
            return Effect.succeed(response);
          }).pipe(Effect.provideContext(context)),
        );
        const answer = yield* serve(
          make(Layer.merge(app, nesting), { api: apis, guard: frame }),
        )("/notes/1");
        expect(answer).toMatchObject({
          status: 500,
          body: "",
          cors: "https://app.test",
        });
        expect(answer.log.at(-1)).toBe("settle:500");
        expect(answer.log).not.toContain("callback");
        expect(answer.log).not.toContain("late");
      }),
  );

  it.effect.each([
    [
      "appended",
      (_: Context.Context<never>) =>
        HttpEffect.appendPreResponseHandler((_request, response) =>
          latest(response),
        ),
    ],
    [
      "appended unsafely",
      (context: Context.Context<never>) =>
        Effect.sync(() =>
          HttpEffect.appendPreResponseHandlerUnsafe(context, (_, response) =>
            latest(response),
          ),
        ),
    ],
    [
      "dying",
      (_: Context.Context<never>) =>
        HttpEffect.appendPreResponseHandler(() =>
          Effect.die(new Error("late callback")),
        ),
    ],
  ] as const)(
    "a global middleware's %s handler answers 500 and never runs",
    ([, register]) =>
      Effect.gen(function* () {
        const answer = yield* serve(
          make(Layer.merge(app, registering(register as never)), {
            api: apis,
            guard: frame,
          }),
        )("/notes/1");
        expect(answer).toMatchObject({ status: 500, cors: "https://app.test" });
        expect(answer.log.at(-1)).toBe("settle:500");
        expect(answer.log).not.toContain("callback");
      }),
  );

  // A route spec whose handler registers a handler from inside the function
  // middleware chain, or hands its context to a fiber that registers one
  // after the route's response is made.
  const deep = GroupSpec.make()
    .addFunction(route("now", "GET", "/deep/now"))
    .addFunction(route("later", "GET", "/deep/later"));
  let afterInner = Promise.withResolvers<void>();
  let registeredLate = Promise.withResolvers<void>();
  const deepImpl = GroupImpl.make(schema, deep).pipe(
    Layer.provide(
      FunctionImpl.make(schema, deep, "now", () =>
        Effect.withFiber((fiber) => {
          HttpEffect.appendPreResponseHandlerUnsafe(
            fiber.context,
            (_, response) => latest(response),
          );
          return Effect.succeed("now");
        }),
      ),
    ),
    Layer.provide(
      FunctionImpl.make(schema, deep, "later", () =>
        Effect.withFiber((fiber) => {
          void afterInner.promise.then(() => {
            HttpEffect.appendPreResponseHandlerUnsafe(fiber.context, late);
            return registeredLate.resolve();
          });
          return Effect.succeed("later");
        }),
      ),
    ),
    GroupImpl.finalize,
  );
  const deepRoutes = Routes.make(schema, { deep: [deep, deepImpl] });
  // As Frame's guard settles with an asynchronous mutation, during which any
  // product fiber still running can act.
  const settlesSlowly = Guard.make("slow", (inner) =>
    Effect.gen(function* () {
      const response = yield* inner;
      afterInner.resolve();
      yield* Effect.promise(() => registeredLate.promise);
      log.push(`settle:${response.status}`);
      return response;
    }).pipe(Effect.map(cors)),
  );

  it.effect(
    "a route handler's own registration answers 500 and never runs",
    () =>
      Effect.gen(function* () {
        const answer = yield* serve(
          make(deepRoutes.routes, { api: deepRoutes.api, guard: frame }),
        )("/deep/now");
        expect(answer).toMatchObject({ status: 500, cors: "https://app.test" });
        expect(answer.log).toEqual(["guard:deep:now", "settle:500"]);
      }),
  );

  it.effect(
    "a registration after the route's response is made never runs",
    () =>
      Effect.gen(function* () {
        afterInner = Promise.withResolvers<void>();
        registeredLate = Promise.withResolvers<void>();
        const answer = yield* serve(
          make(deepRoutes.routes, {
            api: deepRoutes.api,
            guard: settlesSlowly,
          }),
        )("/deep/later");
        expect(answer).toMatchObject({
          status: 200,
          body: '"later"',
          cors: "https://app.test",
        });
        expect(answer.log).toEqual(["settle:200"]);
      }),
  );

  it.effect("a hand-written endpoint keeps its pre-response handler", () =>
    Effect.gen(function* () {
      const teapot = registering(() =>
        HttpEffect.appendPreResponseHandler(() =>
          Effect.sync(() => {
            log.push("callback");
            return HttpServerResponse.text("changed", { status: 418 });
          }),
        ),
      );
      const answer = yield* serve(
        make(Layer.merge(app, teapot), { api: apis, guard: frame }),
      )("/plain");
      expect(answer).toMatchObject({ status: 418, body: "changed" });
      expect(Arr.filter(answer.log, (line) => line === "callback")).toEqual([
        "callback",
      ]);
    }),
  );

  it.effect(
    "without Effect's request state where Confect reads it, a route request answers 500 and runs no product code",
    () =>
      Effect.gen(function* () {
        const blind = Guard.make("blind", (inner) =>
          // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- An HttpMiddleware's result channels are Effect's own erased any.
          frame(
            Effect.updateContext(inner, Context.omit(RequestState) as never),
          ),
        );
        const answer = yield* serve(make(app, { api: apis, guard: blind }))(
          "/notes/1",
        );
        expect(answer).toMatchObject({ status: 500, cors: "https://app.test" });
        expect(answer.log).toEqual(["guard:notes:read", "settle:500"]);
      }),
  );

  it.effect(
    "a response conversion that throws becomes Effect's 500 before the guard settles",
    () =>
      Effect.gen(function* () {
        const unconvertible = {
          [HttpServerRespondable.symbol]() {
            throw new Error("conversion broke");
          },
        };
        const broken = HttpRouter.middleware(
          (inner) => Effect.andThen(inner, Effect.die(unconvertible)),
          { global: true },
        );
        const answer = yield* serve(
          make(Layer.merge(app, broken), { api: apis, guard: frame }),
        )("/notes/1");
        expect(answer.status).toBe(500);
        expect(answer.log.at(-1)).toBe("settle:500");
      }),
  );
});

describe("after inner answers, nothing product code holds changes the response", () => {
  interface Settled {
    readonly status: number;
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly cookies: ReadonlyArray<string>;
  }
  // What the guard settled, read as Frame stores it. A body it cannot read
  // without running product code is recorded as such, so it never matches.
  let settled: Settled | undefined;
  // What product code answered, written out independently of the guard.
  interface Expected {
    readonly body: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly cookies?: ReadonlyArray<string>;
  }
  // Resolved once `inner` answers, so product code can act after it.
  let answered = Promise.withResolvers<void>();
  // Resolved once product code has acted late, or at once for a channel that
  // acts only inside `inner`.
  let acted = Promise.withResolvers<void>();

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const bodyOf = ({ body }: HttpServerResponse.HttpServerResponse) =>
    body._tag === "Uint8Array"
      ? decoder.decode(body.body)
      : body._tag === "Empty"
        ? ""
        : `unread ${body._tag} body`;
  // A form body with its random multipart boundary written as `BOUNDARY`.
  const unbounded = (body: string) => {
    const [first] = pipe(body, Str.split("\r\n"));
    return pipe(first, Str.startsWith("--"))
      ? pipe(body, Str.replaceAll(pipe(first, Str.slice(2)), "BOUNDARY"))
      : body;
  };

  // An ordinary guard: `inner` in a scope of its own and CORS on every
  // response. It settles asynchronously, as Frame's mutation does, while
  // product work still running acts.
  const settling = Guard.make("settling", (inner) =>
    Effect.gen(function* () {
      const answer = yield* Effect.scoped(inner);
      const response = cors(answer);
      settled = {
        status: response.status,
        body: bodyOf(response),
        headers: { ...response.headers },
        cookies: Cookies.toSetCookieHeaders(response.cookies),
      };
      answered.resolve();
      yield* Effect.promise(() => acted.promise);
      log.push(`settle:${response.status}`);
      return response;
    }),
  );

  const lateHandler: HttpEffect.PreResponseHandler = () =>
    Effect.sync(() => {
      log.push("late");
      return HttpServerResponse.text("late", { status: 419 });
    });
  const afterAnswer = (act: () => void) =>
    void answered.promise.then(() => {
      act();
      return acted.resolve();
    });
  const global = (middleware: HttpMiddleware.HttpMiddleware) =>
    HttpRouter.middleware(middleware, { global: true });
  // Headers and cookies of product code's own, on every answer it makes.
  const productOwned = (response: HttpServerResponse.HttpServerResponse) =>
    response.pipe(
      HttpServerResponse.setHeader("x-product", "sentinel"),
      HttpServerResponse.setCookieUnsafe("first", "1", { path: "/" }),
      HttpServerResponse.setCookieUnsafe("second", "2", { path: "/" }),
    );
  const owned = {
    headers: { "x-product": "sentinel" },
    cookies: ["first=1; Path=/", "second=2; Path=/"],
  };
  // A refusal, or an answer with no body, and the route's own answer.
  const empty: Expected = { body: "" };
  const routed: Expected = { body: '"id=1"' };
  // A product global middleware that answers with a body of its own.
  const answering = (body: () => HttpServerResponse.HttpServerResponse) =>
    global((inner) => Effect.as(inner, productOwned(body())));
  const appendLate = (context: Context.Context<never>) =>
    HttpEffect.appendPreResponseHandlerUnsafe(context, lateHandler);
  // An error whose stack, read when its cause is described, appends a handler
  // through whichever fiber is reading it.
  const appendingWhenRead = () => {
    const error = new Error("conversion broke");
    Object.defineProperty(error, "stack", {
      get: () => {
        const fiber = Fiber.getCurrent();
        if (fiber !== undefined) appendLate(fiber.context);
        return "Error: conversion broke";
      },
    });
    return error;
  };

  // Every channel from product code to the response, or to anything that runs
  // after `inner`, with the status the guard settles once each is closed,
  // whether product code acts after `inner` answers, and what product code
  // answered.
  const channels = [
    [
      "a pre-response handler appended inside inner",
      global((inner) =>
        Effect.andThen(HttpEffect.appendPreResponseHandler(lateHandler), inner),
      ),
      500,
      "inner",
      empty,
    ],
    [
      "a pre-response handler appended later through a kept context",
      global((inner) =>
        Effect.withFiber((fiber) => {
          const { context } = fiber;
          afterAnswer(() => appendLate(context));
          return inner;
        }),
      ),
      200,
      "late",
      routed,
    ],
    [
      "a pre-response handler appended later through a kept fiber",
      global((inner) =>
        Effect.withFiber((fiber) => {
          afterAnswer(() => appendLate(fiber.context));
          return inner;
        }),
      ),
      200,
      "late",
      routed,
    ],
    [
      "a scope finalizer that appends a handler",
      global((inner) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          yield* Scope.addFinalizer(
            scope,
            Effect.withFiber((fiber) => {
              appendLate(fiber.context);
              return Effect.void;
            }),
          );
          return yield* inner;
        }),
      ),
      500,
      "inner",
      empty,
    ],
    [
      "a finalizer that appends a handler through the current fiber",
      global((inner) =>
        Effect.andThen(
          Effect.addFinalizer(() => {
            const fiber = Fiber.getCurrent();
            if (fiber !== undefined) appendLate(fiber.context);
            return Effect.void;
          }),
          inner,
        ),
      ),
      500,
      "inner",
      empty,
    ],
    [
      "a fiber forked into the request's scope",
      global((inner) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          yield* Effect.forkIn(
            Effect.never.pipe(
              Effect.onInterrupt(() =>
                HttpEffect.appendPreResponseHandler(lateHandler),
              ),
            ),
            scope,
            { startImmediately: true },
          );
          return yield* inner;
        }),
      ),
      500,
      "inner",
      empty,
    ],
    [
      "a child fiber",
      global((inner) =>
        Effect.andThen(
          Effect.forkChild(
            Effect.never.pipe(
              Effect.onInterrupt(() =>
                HttpEffect.appendPreResponseHandler(lateHandler),
              ),
            ),
            { startImmediately: true },
          ),
          inner,
        ),
      ),
      500,
      "inner",
      empty,
    ],
    [
      "a detached fiber that appends a handler later",
      global((inner) =>
        Effect.andThen(
          Effect.forkDetach(
            Effect.promise(() => answered.promise).pipe(
              Effect.andThen(HttpEffect.appendPreResponseHandler(lateHandler)),
              Effect.andThen(Effect.sync(() => acted.resolve())),
            ),
            { startImmediately: true },
          ),
          inner,
        ),
      ),
      200,
      "late",
      routed,
    ],
    [
      "a failure whose response conversion appends a handler",
      global((inner) =>
        Effect.andThen(
          inner,
          Effect.die({
            [HttpServerRespondable.symbol]: () =>
              Effect.withFiber((fiber) => {
                appendLate(fiber.context);
                return Effect.succeed(
                  HttpServerResponse.text("converted", { status: 418 }),
                );
              }),
          }),
        ),
      ),
      500,
      "inner",
      empty,
    ],
    [
      "a completion observer that appends a handler",
      global((inner) =>
        Effect.withFiber((fiber) => {
          fiber.addObserver(() => appendLate(fiber.context));
          return inner;
        }),
      ),
      200,
      "inner",
      routed,
    ],
    [
      "a completion observer that keeps the fiber completing it",
      // Answering at once with no body, so product code can finish without
      // yielding.
      global(() =>
        Effect.withFiber((fiber) => {
          fiber.addObserver(() => {
            const current = Fiber.getCurrent();
            afterAnswer(() => {
              if (current !== undefined) appendLate(current.context);
            });
          });
          return Effect.succeed(HttpServerResponse.empty({ status: 204 }));
        }),
      ),
      204,
      "late",
      empty,
    ],
    [
      "a failure whose error's stack getter appends a handler",
      global((inner) =>
        Effect.andThen(
          inner,
          Effect.die({
            [HttpServerRespondable.symbol]() {
              throw appendingWhenRead();
            },
          }),
        ),
      ),
      500,
      "inner",
      empty,
    ],
    [
      "a byte body changed later",
      answering(() => {
        const bytes = encoder.encode("early");
        afterAnswer(() => bytes.set(encoder.encode("late!")));
        return HttpServerResponse.uint8Array(bytes, {
          contentType: "text/plain",
        });
      }),
      200,
      "late",
      { body: "early", ...owned },
    ],
    [
      "a byte body changed by a finalizer of product code's own",
      global((inner) =>
        Effect.andThen(
          inner,
          Effect.gen(function* () {
            const bytes = encoder.encode("early");
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => bytes.set(encoder.encode("late!"))),
            );
            return productOwned(
              HttpServerResponse.uint8Array(bytes, {
                contentType: "text/plain",
              }),
            );
          }),
        ),
      ),
      200,
      "inner",
      { body: "early", ...owned },
    ],
    [
      "a stream body produced as it is sent",
      answering(() => {
        let word = "early";
        afterAnswer(() => {
          word = "late";
        });
        return HttpServerResponse.stream(
          Stream.suspend(() => Stream.make(encoder.encode(word))),
          { contentType: "text/plain" },
        );
      }),
      200,
      "late",
      { body: "early", ...owned },
    ],
    [
      "a web stream body read as it is sent",
      answering(() => {
        let word = "early";
        afterAnswer(() => {
          word = "late";
        });
        return HttpServerResponse.raw(
          new ReadableStream<Uint8Array>({
            pull: (controller) => {
              controller.enqueue(encoder.encode(word));
              controller.close();
            },
          }),
          { contentType: "text/plain" },
        );
      }),
      200,
      "late",
      { body: "early", ...owned },
    ],
    [
      "a form body changed later",
      answering(() => {
        const form = new FormData();
        form.set("word", "early");
        afterAnswer(() => form.set("word", "late"));
        return HttpServerResponse.formData(form);
      }),
      200,
      "late",
      {
        body: '--BOUNDARY\r\nContent-Disposition: form-data; name="word"\r\n\r\nearly\r\n--BOUNDARY--\r\n',
        ...owned,
      },
    ],
    [
      "a web Response body with a status of its own",
      answering(() =>
        HttpServerResponse.raw(new Response("its own", { status: 419 })),
      ),
      419,
      "inner",
      { body: "its own", ...owned },
    ],
    [
      "Effect's HttpMiddleware.cors",
      global(HttpMiddleware.cors()),
      500,
      "inner",
      empty,
    ],
    [
      "Effect's HttpMiddleware.compression",
      global(HttpMiddleware.compression()),
      500,
      "inner",
      empty,
    ],
    [
      "HttpApiBuilder.securitySetCookie",
      global((inner) =>
        Effect.andThen(
          HttpApiBuilder.securitySetCookie(
            HttpApiSecurity.apiKey({ key: "session", in: "cookie" }),
            "value",
          ),
          inner,
        ),
      ),
      500,
      "inner",
      empty,
    ],
    [
      "a completion observer that keeps the answer's body",
      global((inner) =>
        Effect.andThen(
          inner,
          Effect.withFiber((fiber) => {
            fiber.addObserver((exit) => {
              afterAnswer(() => {
                if (Exit.isFailure(exit)) return;
                // The fiber's result, read as the plain data it is.
                const { response } = exit.value as {
                  readonly response: { readonly body: Uint8Array };
                };
                response.body.set(encoder.encode("late!"));
              });
            });
            return Effect.succeed(
              HttpServerResponse.uint8Array(encoder.encode("early"), {
                contentType: "text/plain",
              }).pipe(productOwned),
            );
          }),
        ),
      ),
      200,
      "late",
      { body: "early", ...owned },
    ],
    [
      "a web Response with cookies of distinct names",
      answering(() =>
        HttpServerResponse.raw(
          new Response("early", {
            status: 202,
            headers: [
              ["set-cookie", "session=one; Path=/a; HttpOnly"],
              ["set-cookie", "theme=dark; Path=/b"],
            ],
          }),
        ),
      ),
      202,
      "inner",
      {
        body: "early",
        headers: owned.headers,
        cookies: [
          "session=one; Path=/a; HttpOnly",
          "theme=dark; Path=/b",
          ...owned.cookies,
        ],
      },
    ],
    [
      "a web Response with two cookies of one name",
      answering(() =>
        HttpServerResponse.raw(
          new Response("early", {
            status: 202,
            headers: [
              ["set-cookie", "session=one; Path=/a; HttpOnly"],
              ["set-cookie", "session=two; Path=/b; HttpOnly"],
            ],
          }),
        ),
      ),
      500,
      "inner",
      empty,
    ],
  ] as const;

  it.effect.each(channels)(
    "%s: the client receives what the guard settled",
    ([, channel, settles, acts, expected]: readonly [
      string,
      unknown,
      number,
      "inner" | "late",
      Expected,
    ]) =>
      Effect.gen(function* () {
        settled = undefined;
        answered = Promise.withResolvers();
        acted = Promise.withResolvers();
        if (acts === "inner") acted.resolve();
        const answer = yield* serve(
          make(Layer.merge(app, channel as never), {
            api: apis,
            guard: settling,
          }),
        )("/notes/1");
        expect(settled).toBeDefined();
        const { status, body, headers, cookies } = settled!;
        // The guard settled what product code answered.
        expect(status).toBe(settles);
        expect(unbounded(body)).toBe(expected.body);
        for (const [name, value] of Rec.toEntries(expected.headers ?? {})) {
          expect([name, headers[name]]).toEqual([name, value]);
        }
        expect(cookies).toEqual(expected.cookies ?? []);
        // The client received what the guard settled.
        expect({ status: answer.status, body: answer.body }).toEqual({
          status,
          body,
        });
        for (const [name, value] of Rec.toEntries(headers)) {
          expect([name, answer.headers[name]]).toEqual([name, value]);
        }
        expect(answer.cookies).toEqual(cookies);
        expect(answer.cors).toBe("https://app.test");
        expect(answer.body).not.toContain("late");
        expect(answer.log).not.toContain("late");
      }),
  );

  it.effect("a later public write to the request state lands nowhere", () =>
    Effect.gen(function* () {
      answered = Promise.withResolvers();
      acted = Promise.withResolvers();
      let loggerDisabled: boolean | undefined;
      const reading = Guard.make("reading", (inner) =>
        Effect.withFiber((fiber) => {
          const state = Context.getUnsafe(fiber.context, RequestState);
          // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- An HttpMiddleware's result channels are Effect's own erased any.
          return settling(inner).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                loggerDisabled = Reflect.get(state, "loggerDisabled");
              }),
            ),
          );
        }),
      );
      const disabling = global((inner) =>
        Effect.andThen(
          Effect.forkDetach(
            Effect.promise(() => answered.promise).pipe(
              Effect.andThen(
                HttpMiddleware.withLoggerDisabled(
                  Effect.sync(() => acted.resolve()),
                ),
              ),
            ),
            { startImmediately: true },
          ),
          inner,
        ),
      );
      const answer = yield* serve(
        make(Layer.merge(app, disabling), { api: apis, guard: reading }),
      )("/notes/1");
      expect(answer.status).toBe(200);
      expect(loggerDisabled).toBe(false);
    }),
  );
});

describe("the response the guard sees, built from product code's answer", () => {
  // What the guard sees of a product global middleware's answer, and what the
  // client receives.
  const through = (answer: () => HttpServerResponse.HttpServerResponse) =>
    Effect.gen(function* () {
      let observed: HttpServerResponse.HttpServerResponse | undefined;
      const guard = Guard.make("seeing", (inner) =>
        Effect.map(inner, (response) => {
          observed = response;
          return response;
        }),
      );
      const answering = HttpRouter.middleware(
        (inner) => Effect.as(inner, answer()),
        { global: true },
      );
      const client = yield* serve(
        make(Layer.merge(app, answering), { api: apis, guard }),
      )("/notes/1");
      return { observed: observed!, client };
    });

  it.effect("a body with no content type gains application/octet-stream", () =>
    Effect.gen(function* () {
      const { observed, client } = yield* through(() =>
        HttpServerResponse.raw(new Response(new Uint8Array([104, 105]))),
      );
      expect(observed.body).toMatchObject({
        _tag: "Uint8Array",
        contentType: "application/octet-stream",
      });
      expect(client).toMatchObject({
        status: 200,
        body: "hi",
        headers: { "content-type": "application/octet-stream" },
      });
    }),
  );

  it.effect("a status text is dropped", () =>
    Effect.gen(function* () {
      const { observed, client } = yield* through(() =>
        HttpServerResponse.text("made", { status: 201, statusText: "Made" }),
      );
      expect([observed.status, observed.statusText]).toEqual([201, undefined]);
      expect(client).toMatchObject({
        status: 201,
        statusText: "",
        body: "made",
      });
    }),
  );
});

describe("a guard edits product code's cookies by name", () => {
  // A guard that expires the session at `/b`, as a logout does, after product
  // code answers with these Set-Cookie headers. A client then sends what its
  // cookie store keeps from the received headers, applied in order.
  const loggingOut = (setCookie: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const answering = HttpRouter.middleware(
        (inner) =>
          Effect.as(
            inner,
            HttpServerResponse.raw(
              new Response("early", {
                headers: Arr.map(setCookie, (cookie) => ["set-cookie", cookie]),
              }),
            ),
          ),
        { global: true },
      );
      const guard = Guard.make("logging out", (inner) =>
        Effect.flatMap(inner, (response) =>
          HttpServerResponse.expireCookie(response, "session", {
            path: "/b",
            httpOnly: true,
          }).pipe(Effect.orDie, Effect.map(cors)),
        ),
      );
      const client = yield* serve(
        make(Layer.merge(app, answering), { api: apis, guard }),
      )("/notes/1");
      const now = Date.UTC(2026, 10, 18);
      const stored = Arr.reduce(
        client.cookies,
        [] as ReadonlyArray<Cookies.Cookie>,
        (kept, cookie) =>
          Cookies.mergeIntoArray(
            kept,
            "https://app.test/notes/1",
            Cookies.fromSetCookie(cookie),
            now,
          ),
      );
      const sent = (path: string) =>
        Cookies.toRequestCookieHeader(stored, `https://app.test${path}`, now);
      return { client, sent };
    });
  const expired =
    "session=; Max-Age=0; Path=/b; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly";

  it.effect("expiring the one session cookie logs the client out", () =>
    Effect.gen(function* () {
      const { client, sent } = yield* loggingOut([
        "session=one; Path=/b; HttpOnly",
      ]);
      expect(client).toMatchObject({
        status: 200,
        cors: "https://app.test",
        body: "early",
        cookies: [expired],
      });
      expect(sent("/b/private")).toBeUndefined();
    }),
  );

  it.effect(
    "two cookies of one name answer 500, and no session reaches the client",
    () =>
      Effect.gen(function* () {
        const { client, sent } = yield* loggingOut([
          "session=one; Path=/a; HttpOnly",
          "session=two; Path=/b; HttpOnly",
        ]);
        expect(client).toMatchObject({
          status: 500,
          cors: "https://app.test",
          body: "",
          cookies: [expired],
        });
        expect([sent("/a/private"), sent("/b/private")]).toEqual([
          undefined,
          undefined,
        ]);
      }),
  );
});

describe("classification under a router configuration of its own", () => {
  // Confect's own router takes Effect's default configuration, which matches
  // paths at any case. Built here with Effect's web handler, the router and
  // the gate share one that matches only the route's own case.
  it.effect(
    "a case-sensitive router runs the guard only at the route's case",
    () =>
      Effect.gen(function* () {
        const identity = {
          functionPath: "probe:read",
          spec: route("read", "GET", "/notes/:id"),
        };
        const read = HttpRouter.route(
          "GET",
          "/notes/:id",
          Effect.succeed(HttpServerResponse.text("served")),
        );
        identities.set(read, identity);
        const guard = Guard.make("probe", (inner) =>
          Effect.flatMap(Routes.Route, ({ functionPath }) => {
            log.push(`guard:${functionPath}`);
            return inner;
          }),
        );
        const config = { caseSensitive: true };
        const { handler, dispose } = HttpRouter.toWebHandler(
          withOptions(
            Layer.effectDiscard(
              Effect.flatMap(HttpRouter.HttpRouter, (router) =>
                router.addAll([read]),
              ),
            ),
            new Set(),
            {
              guard,
              reflected: new Map([["GET /notes/:id", identity]]),
              mount: Effect.succeed(""),
            },
          ).pipe(Layer.provide(Layer.succeed(HttpRouter.RouterConfig)(config))),
          { routerConfig: config, disableLogger: true },
        );
        // The route needs no service, so the request context is empty.
        const fetch = (path: string) =>
          Effect.gen(function* () {
            log.length = 0;
            const response = yield* Effect.promise(() =>
              handler(
                new Request(`http://test.local${path}`),
                Context.empty() as never,
              ),
            );
            const body = yield* Effect.promise(() => response.text());
            return [response.status, body, [...log]];
          });
        const own = yield* fetch("/notes/1");
        const other = yield* fetch("/NOTES/1");
        yield* Effect.promise(dispose);
        expect(own).toEqual([200, "served", ["guard:probe:read"]]);
        expect([other[0], other[2]]).toEqual([404, []]);
      }),
  );
});

describe("a response body over the result cap", () => {
  const chunk = 512 * 1024;
  // A product global middleware answering with `count` chunks of `chunk`
  // bytes, counting the chunks read.
  const sized = (
    kind: "stream" | "web stream",
    count: number,
    pulled: { n: number },
  ) =>
    HttpRouter.middleware(
      (inner) =>
        Effect.as(
          inner,
          kind === "stream"
            ? HttpServerResponse.stream(
                Stream.fromEffectRepeat(
                  Effect.sync(() => {
                    pulled.n++;
                    return new Uint8Array(chunk);
                  }),
                ).pipe(Stream.take(count)),
                { contentType: "application/json" },
              )
            : HttpServerResponse.raw(
                new ReadableStream<Uint8Array>({
                  pull: (controller) => {
                    pulled.n++;
                    controller.enqueue(new Uint8Array(chunk));
                    if (pulled.n === count) controller.close();
                  },
                }),
                { contentType: "application/json" },
              ),
        ),
      { global: true },
    );

  it.effect.each(["stream", "web stream"] as const)(
    "a %s body answers 500 and stops being read at the cap",
    (kind) =>
      Effect.gen(function* () {
        const pulled = { n: 0 };
        const answer = yield* serve(
          make(Layer.merge(app, sized(kind, 64, pulled)), {
            api: apis,
            guard: frame,
          }),
        )("/notes/1");
        expect(answer).toMatchObject({
          status: 500,
          body: "",
          cors: "https://app.test",
        });
        expect(answer.log.at(-1)).toBe("settle:500");
        expect(pulled.n).toBeLessThanOrEqual(4);
      }),
  );

  it.effect.each(["stream", "web stream"] as const)(
    "a %s body of exactly the cap serves",
    (kind) =>
      Effect.gen(function* () {
        const pulled = { n: 0 };
        const answer = yield* serve(
          make(Layer.merge(app, sized(kind, 2, pulled)), {
            api: apis,
            guard: frame,
          }),
        )("/notes/1");
        expect(answer.status).toBe(200);
        expect(answer.body.length).toBe(2 * chunk);
      }),
  );
});

describe("a server failure inside the guard", () => {
  interface Event {
    readonly level: string;
    readonly message: ReadonlyArray<unknown>;
    readonly annotations: Readonly<Record<string, unknown>>;
    readonly spans: ReadonlyArray<unknown>;
    readonly cause: Cause.Cause<unknown>;
  }
  // Each request's own id, as the guard reads it from Convex.
  const requestIds: Array<string> = [];
  // The guard runs `inner` with an annotation and a log span of the request's
  // own, which the refusal log must not carry.
  const observed = (
    events: Array<Event>,
    logger: Logger.Logger<unknown, void> = Logger.make(
      ({ logLevel, message, cause, fiber }) => {
        events.push({
          level: logLevel,
          message: message as ReadonlyArray<unknown>,
          annotations: {
            ...Context.get(fiber.context, References.CurrentLogAnnotations),
          },
          spans: Context.get(fiber.context, References.CurrentLogSpans),
          cause,
        });
      },
    ),
  ) =>
    Guard.make("observing", (inner) =>
      Effect.gen(function* () {
        const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
        const { requestId } = yield* Effect.promise(() =>
          ctx.meta.getRequestMetadata(),
        );
        requestIds.push(requestId);
        // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- An HttpMiddleware's result channels are Effect's own erased any.
        return yield* frame(
          inner.pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
            Effect.annotateLogs({ query: "token=request-secret" }),
            Effect.withLogSpan("request /notes/1?token=request-secret"),
          ),
        );
      }),
    );
  const only = (events: ReadonlyArray<Event>) => {
    expect(Arr.map(events, ({ level }) => level)).toEqual(["Error"]);
    const [event] = events as [Event];
    expect(Rec.keys(event.annotations).sort()).toEqual([
      "functionPath",
      "requestId",
    ]);
    expect(event.annotations["functionPath"]).toBe("notes:read");
    expect(event.annotations["requestId"]).toBe(requestIds.at(-1));
    expect(event.spans).toEqual([]);
    expect(event.cause.reasons).toEqual([]);
    expect(event.message).toEqual([expect.any(String)]);
    expect(String(event.message[0])).not.toContain("request-secret");
    return String(event.message[0]);
  };

  it.effect(
    "is logged at error level with the cause as text, the request id and the function path alone",
    () =>
      Effect.gen(function* () {
        const events: Array<Event> = [];
        const broken = HttpRouter.middleware(
          (inner) =>
            Effect.andThen(inner, Effect.die(new Error("product bug"))),
          { global: true },
        );
        const answer = yield* serve(
          make(Layer.merge(app, broken), {
            api: apis,
            guard: observed(events),
          }),
        )("/notes/1?token=request-secret");
        expect(answer.status).toBe(500);
        expect(only(events)).toContain("product bug");
      }),
  );

  it.effect("names each request by its own Convex request id", () =>
    Effect.gen(function* () {
      const events: Array<Event> = [];
      const broken = HttpRouter.middleware(
        (inner) => Effect.andThen(inner, Effect.die(new Error("product bug"))),
        { global: true },
      );
      const sendBroken = serve(
        make(Layer.merge(app, broken), {
          api: apis,
          guard: observed(events),
        }),
      );
      requestIds.length = 0;
      yield* sendBroken("/notes/1");
      yield* sendBroken("/notes/2");
      expect(requestIds).toHaveLength(2);
      expect(requestIds[0]).not.toBe(requestIds[1]);
      expect(
        Arr.map(events, ({ annotations }) => annotations["requestId"]),
      ).toEqual(requestIds);
    }),
  );

  // A string defect is described as `Error: ` and the string.
  it.effect.each([
    { length: 8191, logged: 8191 },
    { length: 8192, logged: 8192 },
    { length: 8193, logged: 8192 },
    { length: 20_000, logged: 8192 },
  ])(
    "a cause of $length characters is logged as $logged",
    ({ length, logged }) =>
      Effect.gen(function* () {
        const events: Array<Event> = [];
        const cause = `Error: ${pipe("x", Str.repeat(length - 7))}`;
        const broken = HttpRouter.middleware(
          (inner) =>
            Effect.andThen(inner, Effect.die(pipe(cause, Str.slice(7)))),
          { global: true },
        );
        const answer = yield* serve(
          make(Layer.merge(app, broken), {
            api: apis,
            guard: observed(events),
          }),
        )("/notes/1");
        expect(answer.status).toBe(500);
        const message = only(events);
        expect(message).toHaveLength(logged);
        expect(message).toBe(
          length === logged
            ? cause
            : `${pipe(cause, Str.slice(0, logged - 1))}…`,
        );
      }),
  );

  it.effect("a rewrite refusal's log names no request URL", () =>
    Effect.gen(function* () {
      const events: Array<Event> = [];
      const answer = yield* serve(
        make(app, { api: apis, guard: observed(events) }),
      )("/notes/1", {
        headers: { "x-rewrite": "/plain?token=request-secret" },
      });
      expect(answer.status).toBe(500);
      expect(only(events)).toContain("another route");
    }),
  );

  it.effect("a cookie name set twice is logged by name, never its value", () =>
    Effect.gen(function* () {
      const events: Array<Event> = [];
      const twice = HttpRouter.middleware(
        (inner) =>
          Effect.as(
            inner,
            HttpServerResponse.raw(
              new Response("early", {
                headers: [
                  ["set-cookie", "theme=dark; Path=/"],
                  ["set-cookie", "session=secret-one; Path=/a"],
                  ["set-cookie", "session=secret-two; Path=/b"],
                ],
              }),
            ),
          ),
        { global: true },
      );
      const answer = yield* serve(
        make(Layer.merge(app, twice), { api: apis, guard: observed(events) }),
      )("/notes/1");
      expect(answer.status).toBe(500);
      const message = only(events);
      expect(message).toContain('"session"');
      expect(message).not.toContain("theme");
      expect(message).not.toContain("secret");
    }),
  );

  it.effect.each([{ length: 8192 }, { length: 20_000 }])(
    "a cookie name of $length characters set twice is logged within the cap",
    ({ length }) =>
      Effect.gen(function* () {
        const events: Array<Event> = [];
        const name = pipe("n", Str.repeat(length));
        const twice = HttpRouter.middleware(
          (inner) =>
            Effect.as(
              inner,
              HttpServerResponse.raw(
                new Response("early", {
                  status: 202,
                  headers: [
                    ["set-cookie", `${name}=value-secret-one; Path=/a`],
                    ["set-cookie", `${name}=value-secret-two; Path=/b`],
                  ],
                }),
              ),
            ),
          { global: true },
        );
        const answer = yield* serve(
          make(Layer.merge(app, twice), { api: apis, guard: observed(events) }),
        )("/notes/1");
        expect(answer.status).toBe(500);
        const message = only(events);
        expect(message).toHaveLength(8192);
        expect(pipe(message, Str.endsWith("…"))).toBe(true);
        expect(message).not.toContain("value-secret");
      }),
  );

  it.effect(
    "a logger that throws still leaves the guard its 500 to settle",
    () =>
      Effect.gen(function* () {
        const throwing = Logger.make(() => {
          throw new Error("logger unavailable");
        });
        const broken = HttpRouter.middleware(
          (inner) =>
            Effect.andThen(inner, Effect.die(new Error("product bug"))),
          { global: true },
        );
        const answer = yield* serve(
          make(Layer.merge(app, broken), {
            api: apis,
            guard: observed([], throwing),
          }),
        )("/notes/1");
        expect(answer).toMatchObject({
          status: 500,
          body: "",
          cors: "https://app.test",
        });
        expect(answer.log.at(-1)).toBe("settle:500");
      }),
  );

  it.effect(
    "a cause that throws when described still leaves the guard its 500 to settle",
    () =>
      Effect.gen(function* () {
        const unreadable = new Error("unreadable");
        Object.defineProperty(unreadable, "stack", {
          get: () => {
            throw new Error("no stack");
          },
        });
        const broken = HttpRouter.middleware(
          (inner) =>
            Effect.andThen(
              inner,
              Effect.die({
                [HttpServerRespondable.symbol]() {
                  throw unreadable;
                },
              }),
            ),
          { global: true },
        );
        const answer = yield* serve(
          make(Layer.merge(app, broken), { api: apis, guard: frame }),
        )("/notes/1");
        expect(answer).toMatchObject({
          status: 500,
          body: "",
          cors: "https://app.test",
        });
        expect(answer.log.at(-1)).toBe("settle:500");
      }),
  );

  it.effect("a declared error's response is not logged", () =>
    Effect.gen(function* () {
      const events: Array<Event> = [];
      const answer = yield* serve(
        make(app, { api: apis, guard: observed(events) }),
      )("/nope");
      expect(answer.status).toBe(422);
      expect(events).toEqual([]);
    }),
  );
});

describe("the HTTP guide's CORS setup", () => {
  it.effect("gives route and hand-written paths CORS", () =>
    Effect.gen(function* () {
      const allowing = HttpMiddleware.cors();
      const exceptRoutes = HttpRouter.middleware(
        (inner) =>
          Effect.flatMap(Effect.serviceOption(Routes.Route), (onRoute) =>
            Option.isSome(onRoute) ? inner : allowing(inner),
          ),
        { global: true },
      );
      const sendBoth = serve(
        make(Layer.merge(app, exceptRoutes), {
          api: apis,
          guard: Guard.make("cors", allowing),
        }),
      );
      const routed = yield* sendBoth("/notes/1");
      const plain = yield* sendBoth("/plain");
      expect(routed).toMatchObject({ status: 200, cors: "*" });
      expect(plain).toMatchObject({ status: 200, cors: "*" });
    }),
  );
});

describe("Effect's request state, which Confect reads by its internal key", () => {
  // WORKAROUND canary: fails when an Effect upgrade renames or moves the key or
  // the field Confect reads, so the WORKAROUND in internal/httpOptions.ts is
  // revisited before the upgrade lands.
  it.effect(
    "is in a request's context, and Effect runs the handler its field holds",
    () =>
      Effect.gen(function* () {
        const direct = HttpRouter.add(
          "GET",
          "/direct",
          Effect.gen(function* () {
            const state = yield* Effect.serviceOption(RequestState);
            log.push(Option.isSome(state) ? "state" : "no state");
            if (Option.isSome(state)) {
              state.value.preResponseHandler = () =>
                Effect.succeed(HttpServerResponse.text("ran", { status: 203 }));
            }
            return HttpServerResponse.text("not run");
          }),
        );
        const answer = yield* serve(make(direct, {}))("/direct");
        expect(answer).toMatchObject({
          status: 203,
          body: "ran",
          log: ["state"],
        });
      }),
  );
});
