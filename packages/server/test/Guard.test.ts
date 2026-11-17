import * as IdScope from "@confect/core/IdScope";
import { FunctionSpec, GroupSpec, MiddlewareSpec } from "@confect/core";
import {
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
import { httpActionGeneric } from "convex/server";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import schema from "./mock-backend/fixtures/confect/_generated/schema";

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
        cors: response.headers.get("access-control-allow-origin"),
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
        expect(answer).toEqual({
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
  it.each([
    { path: "/webhooks/raw", method: "POST" },
    { path: "/write", method: "GET" },
    { path: "/notes/7/more", method: "GET" },
    { pathPrefix: "/webhooks/", method: "POST" },
  ] as const)("keeps $method $path$pathPrefix", (spec) => {
    expect(() => router().route({ ...spec, handler })).not.toThrow();
  });
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

describe("product response transforms finish inside the guard", () => {
  const callback = (handler: HttpEffect.PreResponseHandler) =>
    HttpRouter.middleware(
      (inner) =>
        Effect.andThen(HttpEffect.appendPreResponseHandler(handler), inner),
      { global: true },
    );
  const teapot = callback(() =>
    Effect.sync(() => {
      log.push("callback");
      return HttpServerResponse.text("changed", { status: 418 });
    }),
  );

  it.effect(
    "the guard settles the response a pre-response handler returns, which runs once",
    () =>
      Effect.gen(function* () {
        const answer = yield* serve(
          make(Layer.merge(app, teapot), { api: apis, guard: frame }),
        )("/notes/1");
        expect(answer).toMatchObject({
          status: 418,
          body: "changed",
          cors: "https://app.test",
        });
        expect(answer.log.slice(-2)).toEqual(["callback", "settle:418"]);
      }),
  );

  it.effect("a hand-written endpoint keeps its pre-response handler", () =>
    Effect.gen(function* () {
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
    "a pre-response handler that dies becomes Effect's response before the guard settles",
    () =>
      Effect.gen(function* () {
        const dying = callback(() => Effect.die(new Error("late callback")));
        const answer = yield* serve(
          make(Layer.merge(app, dying), { api: apis, guard: frame }),
        )("/notes/1");
        expect(answer.status).toBe(500);
        expect(answer.log.at(-1)).toBe("settle:500");
      }),
    { timeout: 5000 },
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
