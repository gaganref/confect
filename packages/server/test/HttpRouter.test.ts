import { recording } from "./internal/recording";
import * as IdScope from "@confect/core/IdScope";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as ConfectHttpRouter from "@confect/server/HttpRouter";
import { assert, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { convexTest } from "convex-test";
import { httpActionGeneric } from "convex/server";
import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Tracer from "effect/Tracer";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiError from "effect/http-api/HttpApiError";

const api = HttpApi.make("users").add(
  HttpApiGroup.make("users").add(
    HttpApiEndpoint.get("get", "/users/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    }),
    HttpApiEndpoint.post("create", "/users", { success: Schema.String }),
  ),
);
const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(
    HttpApiBuilder.group(api, "users", (handlers) =>
      handlers
        .handle("get", ({ params }) =>
          Effect.as(Effect.logInfo("request"), params.id),
        )
        .handle("create", () => Effect.succeed("created")),
    ),
  ),
);

const labels = (router: ReturnType<typeof ConfectHttpRouter.make>) =>
  router.getRoutes().map(([path, method]) => [method, path]);

const matchLabel = (
  router: ReturnType<typeof ConfectHttpRouter.make>,
  path: string,
  method: "GET" | "POST" | "HEAD" = "GET",
) => router.lookup(path, method)?.slice(1);

describe("HttpRouter", () => {
  it("lists reflected endpoint methods and patterns without catch-all rows", () => {
    const router = ConfectHttpRouter.make(routes, { api });
    expect(labels(router)).toEqual([
      ["OPTIONS", "/users"],
      ["POST", "/users"],
      ["GET", "/users/:id"],
      ["OPTIONS", "/users/:id"],
    ]);
  });

  it("labels matching requests and keeps the catch-all for unmatched requests", () => {
    const router = ConfectHttpRouter.make(routes, { api });
    expect(matchLabel(ConfectHttpRouter.make(routes), "/nope")).toEqual([
      "GET",
      "/*",
    ]);
    expect([
      matchLabel(router, "/users/42"),
      matchLabel(router, "/users", "POST"),
      matchLabel(router, "/users/42", "HEAD"),
      matchLabel(router, "/nope"),
      matchLabel(router, "/users/42", "POST"),
    ]).toEqual([
      ["GET", "/users/:id"],
      ["POST", "/users"],
      ["GET", "/users/:id"],
      ["GET", "/*"],
      ["POST", "/*"],
    ]);
  });

  it("keeps explicit Convex routes ahead of reflected routes", () => {
    const router = ConfectHttpRouter.make(routes, { api });
    const exact = httpActionGeneric(() =>
      Promise.resolve(new Response("exact")),
    );
    const prefix = httpActionGeneric(() =>
      Promise.resolve(new Response("prefix")),
    );
    router.route({ path: "/users/42", method: "GET", handler: exact });
    router.route({ pathPrefix: "/users/", method: "POST", handler: prefix });
    expect(router.lookup("/users/42", "GET")).toEqual([
      exact,
      "GET",
      "/users/42",
    ]);
    expect(router.lookup("/users/42", "POST")).toEqual([
      prefix,
      "POST",
      "/users/*",
    ]);
    expect(labels(router)).toEqual([
      ["GET", "/users/42"],
      ["POST", "/users/*"],
      ["OPTIONS", "/users"],
      ["POST", "/users"],
      ["GET", "/users/:id"],
      ["OPTIONS", "/users/:id"],
    ]);
  });

  it("keeps catch-all labels for plain Effect routes beside an API", () => {
    const router = ConfectHttpRouter.make(
      Layer.mergeAll(
        routes,
        HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
      ),
      { api },
    );
    expect(matchLabel(router, "/health")).toEqual(["GET", "/*"]);
    expect(matchLabel(router, "/users/7")).toEqual(["GET", "/users/:id"]);
  });
});

it("labels component routes relative to the component, with the same reflected API", () => {
  const schema = DatabaseSchema.make(
    {},
    {
      kind: "component",
      scope: IdScope.component("users"),
    },
  );
  const router = ConfectHttpRouter.forSchema(schema)(routes, { api });
  expect(labels(router)).toEqual([
    ["OPTIONS", "/users"],
    ["POST", "/users"],
    ["GET", "/users/:id"],
    ["OPTIONS", "/users/:id"],
  ]);
  expect(matchLabel(router, "/users/42")).toEqual(["GET", "/users/:id"]);
  expect(matchLabel(router, "/nope")).toEqual(["GET", "/*"]);
});

it("keeps unmatched component labels relative to a prefixed API", () => {
  const schema = DatabaseSchema.make(
    {},
    { kind: "component", scope: IdScope.component("users") },
  );
  const prefixedApi = api.prefix("/v1");
  const prefixedRoutes = HttpApiBuilder.layer(prefixedApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(prefixedApi, "users", (handlers) =>
        handlers
          .handle("get", ({ params }) => Effect.succeed(params.id))
          .handle("create", () => Effect.succeed("created")),
      ),
    ),
  );
  const router = ConfectHttpRouter.forSchema(schema)(prefixedRoutes, {
    api: prefixedApi,
  });
  expect(matchLabel(router, "/v1/users/42")).toEqual(["GET", "/v1/users/:id"]);
  expect(router.lookup("/nope", "GET")?.slice(1)).toEqual(["GET", "/*"]);
  expect(
    ConfectHttpRouter.forSchema(schema)(prefixedRoutes)
      .lookup("/nope", "GET")
      ?.slice(1),
  ).toEqual(["GET", "/*"]);
});

it("labels prefixed wildcard routes at their base path and descendants", () => {
  const assetsApi = HttpApi.make("assets")
    .add(
      HttpApiGroup.make("assets").add(
        HttpApiEndpoint.get("download", "/assets/*"),
      ),
    )
    .prefix("/v1");
  const assetsRoutes = HttpApiBuilder.layer(assetsApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(assetsApi, "assets", (handlers) =>
        handlers.handle("download", () => Effect.void),
      ),
    ),
  );
  const router = ConfectHttpRouter.make(assetsRoutes, { api: assetsApi });
  expect(labels(router)).toEqual([
    ["GET", "/v1/assets/*"],
    ["OPTIONS", "/v1/assets/*"],
  ]);
  expect([
    matchLabel(router, "/v1/assets"),
    matchLabel(router, "/v1/assets/"),
    matchLabel(router, "/v1/assets/icons/logo.svg"),
    matchLabel(router, "/v1/elsewhere"),
  ]).toEqual([
    ["GET", "/v1/assets/*"],
    ["GET", "/v1/assets/*"],
    ["GET", "/v1/assets/*"],
    ["GET", "/*"],
  ]);
});

it("distinguishes declared parameters from literal colons in API paths", () => {
  const actionsApi = HttpApi.make("actions").add(
    HttpApiGroup.make("actions").add(
      HttpApiEndpoint.post("cancel", "/items/:id:cancel", {
        params: Schema.Struct({ id: Schema.String }),
      }),
      HttpApiEndpoint.post("archive", "/items/:id:archive", {
        params: Schema.Struct({ id: Schema.String }),
      }),
      HttpApiEndpoint.post("literal", "/literal/:status", {
        params: Schema.Struct({}),
      }),
    ),
  );
  const actionsRoutes = HttpApiBuilder.layer(actionsApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(actionsApi, "actions", (handlers) =>
        handlers
          .handle("cancel", () => Effect.void)
          .handle("archive", () => Effect.void)
          .handle("literal", () => Effect.void),
      ),
    ),
  );
  const router = ConfectHttpRouter.make(actionsRoutes, { api: actionsApi });
  expect([
    matchLabel(router, "/items/42:cancel", "POST"),
    matchLabel(router, "/items/42:archive", "POST"),
    matchLabel(router, "/literal/:status", "POST"),
    matchLabel(router, "/literal/ready", "POST"),
  ]).toEqual([
    ["POST", "/items/:id:cancel"],
    ["POST", "/items/:id:archive"],
    ["POST", "/literal/:status"],
    ["POST", "/*"],
  ]);
});

it("keeps a component mountable when its label API has no routable endpoints", () => {
  const schema = DatabaseSchema.make(
    {},
    {
      kind: "component",
      scope: IdScope.component("health"),
    },
  );
  const router = ConfectHttpRouter.forSchema(schema)(
    HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
    { api: HttpApi.make("empty") },
  );
  expect(labels(router)).toEqual([
    ["DELETE", "/*"],
    ["GET", "/*"],
    ["OPTIONS", "/*"],
    ["PATCH", "/*"],
    ["POST", "/*"],
    ["PUT", "/*"],
  ]);
  expect(matchLabel(router, "/health")).toEqual(["GET", "/*"]);
});

it.effect("uses one labeled request span and the supplied logger", () =>
  Effect.gen(function* () {
    const { spans, messages, observability } = recording();
    vi.stubEnv("CONVEX_SITE_URL", "https://some.convex.site/mounted");
    const schema = DatabaseSchema.make(
      {},
      { kind: "component", scope: IdScope.component("users") },
    );
    const router = ConfectHttpRouter.forSchema(schema)(routes, {
      api,
      observability,
    });
    const t = convexTest(undefined, {
      ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
      "./mock-backend/fixtures/convex/http.ts": () =>
        Promise.resolve({ default: router }),
    });
    const response = yield* Effect.promise(() => t.fetch("/mounted/users/42"));
    expect(yield* Effect.promise(() => response.json())).toBe("42");
    expect(messages).toEqual([["request"]]);
    expect(
      spans.map((span) => [
        span.name,
        span.attributes.get("kind"),
        span.parent._tag,
      ]),
    ).toEqual([["/users/:id", "httpAction", "None"]]);
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
);

it.effect.each([
  "success",
  "denied",
  "defect",
  "remote",
  "forbidden",
  "decode",
] as const)(
  "reports the original HTTP %s outcome on one request span",
  (scenario) =>
    Effect.gen(function* () {
      class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}
      const denied = new Denied();
      const forbidden = new HttpApiError.Forbidden();
      const defect = new Error("broken");
      const recorder = recording();
      const { spans } = recorder;
      const reports: Array<{
        cause: Cause.Cause<unknown>;
        span: Tracer.AnySpan;
      }> = [];
      const filtered: Array<unknown> = [];
      const observability = Layer.merge(
        recorder.observability,
        ErrorReporter.layer([
          ErrorReporter.make(({ cause }) => filtered.push(Cause.squash(cause))),
          {
            [ErrorReporter.TypeId]: ErrorReporter.TypeId,
            report({ cause, fiber }) {
              const span = Context.getUnsafe(fiber.context, Tracer.ParentSpan);
              assert(span._tag === "Span");
              expect(span.status._tag).toBe("Started");
              reports.push({ cause, span });
            },
          },
        ]),
      );
      const outcomeApi = HttpApi.make("outcomes").add(
        HttpApiGroup.make("outcomes").add(
          HttpApiEndpoint.get("run", "/outcomes/:id", {
            params: Schema.Struct({
              id: Schema.Literals([
                "success",
                "denied",
                "defect",
                "remote",
                "forbidden",
              ]),
            }),
            success: Schema.String,
            error: [
              Denied.pipe(HttpApiSchema.status(403)),
              HttpApiError.Forbidden,
            ],
          }),
        ),
      );
      const outcomeRoutes = HttpApiBuilder.layer(outcomeApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(outcomeApi, "outcomes", (handlers) =>
            handlers.handle("run", ({ params }) =>
              params.id === "denied"
                ? Effect.fail(denied)
                : params.id === "defect"
                  ? Effect.die(defect)
                  : params.id === "forbidden"
                    ? Effect.fail(forbidden)
                    : Effect.succeed("ok"),
            ),
          ),
        ),
      );
      const router = ConfectHttpRouter.make(outcomeRoutes, {
        api: outcomeApi,
        observability,
      });
      const t = convexTest(undefined, {
        ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
        "./mock-backend/fixtures/convex/http.ts": () =>
          Promise.resolve({ default: router }),
      });
      yield* Effect.promise(() =>
        RegisteredFunction.runHandlerPromise(undefined, { observability })(
          Effect.void,
        ),
      );
      const headers: HeadersInit =
        scenario === "remote"
          ? {
              traceparent:
                "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            }
          : {};
      const response = yield* Effect.promise(() =>
        t.fetch(`/outcomes/${scenario}`, { headers }),
      );
      const body = yield* Effect.promise(() => response.text());
      const baseline = convexTest(undefined, {
        ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
        "./mock-backend/fixtures/convex/http.ts": () =>
          Promise.resolve({
            default: ConfectHttpRouter.make(outcomeRoutes, { api: outcomeApi }),
          }),
      });
      const unobserved = yield* Effect.promise(() =>
        baseline.fetch(`/outcomes/${scenario}`, { headers }),
      );
      expect([response.status, body]).toEqual([
        unobserved.status,
        yield* Effect.promise(() => unobserved.text()),
      ]);

      expect(response.status).toBe(
        scenario === "decode"
          ? 400
          : scenario === "denied" || scenario === "forbidden"
            ? 403
            : scenario === "defect"
              ? 500
              : 200,
      );
      expect(body).toBe(
        scenario === "denied"
          ? '{"_tag":"Denied"}'
          : scenario === "forbidden"
            ? '{"_tag":"Forbidden"}'
            : scenario === "defect" || scenario === "decode"
              ? ""
              : '"ok"',
      );
      expect(spans).toHaveLength(1);
      expect(spans[0]!.status).toMatchObject({
        exit: { _tag: scenario === "defect" ? "Failure" : "Success" },
      });
      expect([spans[0]!.name, spans[0]!.attributes.get("kind")]).toEqual([
        "/outcomes/:id",
        "httpAction",
      ]);
      expect(filtered).toEqual(
        scenario === "denied"
          ? [denied]
          : scenario === "defect"
            ? [defect]
            : [],
      );
      if (scenario === "decode") {
        expect(reports.map(({ cause }) => Cause.squash(cause))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              _tag: "HttpApiSchemaError",
              kind: "Params",
            }),
          ]),
        );
        for (const report of reports) expect(report.span).toBe(spans[0]);
      } else if (
        scenario === "denied" ||
        scenario === "defect" ||
        scenario === "forbidden"
      ) {
        const original =
          scenario === "denied"
            ? denied
            : scenario === "forbidden"
              ? forbidden
              : defect;
        expect(reports[0]!.span).toBe(spans[0]);
        for (const { cause, span } of reports) {
          expect(Cause.squash(cause)).toBe(original);
          expect(span).toBe(spans[0]);
        }
      } else expect(reports).toEqual([]);
      expect(spans[0]!.parent._tag).toBe(
        scenario === "remote" ? "Some" : "None",
      );
      if (scenario === "remote") {
        expect(spans[0]!.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
        expect(spans[0]!.parent).toMatchObject({
          value: { spanId: "b7ad6b7169203331", _tag: "ExternalSpan" },
        });
      }
      expect(
        (yield* Effect.promise(() => t.fetch("/outcomes/success"))).status,
      ).toBe(200);
      expect(spans).toHaveLength(2);
      expect(recorder.lifecycle).toEqual({ builds: 1, releases: 0 });
    }),
);

it.effect("keeps ConvexLogger for HTTP without a runtime layer", () =>
  Effect.gen(function* () {
    const info = vi.spyOn(globalThis.console, "info");
    try {
      const router = ConfectHttpRouter.make(
        HttpRouter.add(
          "GET",
          "/log",
          Effect.andThen(
            Effect.logInfo("default http"),
            Effect.match(Effect.currentSpan, {
              onFailure: () => HttpServerResponse.text("no span"),
              onSuccess: () => HttpServerResponse.text("unexpected span"),
            }),
          ),
        ),
      );
      const t = convexTest(undefined, {
        ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
        "./mock-backend/fixtures/convex/http.ts": () =>
          Promise.resolve({ default: router }),
      });
      expect(
        yield* Effect.promise(() =>
          t.fetch("/log").then((response) => response.text()),
        ),
      ).toBe("no span");
      expect(info).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "default http" }),
      );
    } finally {
      info.mockRestore();
    }
  }),
);

class RouteInfo extends Context.Service<
  RouteInfo,
  { readonly target: string }
>()("@confect/server/test/HttpRouter.test/RouteInfo") {}
class Guard extends HttpApiMiddleware.Service<Guard>()("Guard") {}

const guardedApi = HttpApi.make("conflict").add(
  HttpApiGroup.make("probe").add(
    HttpApiEndpoint.post("run", "/probe", {
      payload: Schema.Struct({ value: Schema.String }),
      success: Schema.String,
    })
      .annotate(RouteInfo, { target: "probe:run" })
      .middleware(Guard),
  ),
);

it.effect.each([
  { method: "POST", path: "/probe", expected: 401 },
  { method: "OPTIONS", path: "/probe", expected: 204 },
  { method: "OPTIONS", path: "/missing", expected: 404 },
])(
  "answers $method $path through middleware before decoding",
  ({ method, path, expected }) =>
    Effect.gen(function* () {
      const guardedRoutes = HttpApiBuilder.layer(guardedApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(guardedApi, "probe", (handlers) =>
            handlers.handle("run", () => {
              return Effect.die(
                "The handler must not run for a refusal or preflight",
              );
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(Guard, (_next, { endpoint }) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const info = Context.getUnsafe(endpoint.annotations, RouteInfo);
              return HttpServerResponse.empty({
                status:
                  info.target !== "probe:run"
                    ? 500
                    : request.method === "OPTIONS"
                      ? 204
                      : 401,
              });
            }),
          ),
        ),
      );
      const router = ConfectHttpRouter.make(guardedRoutes, { api: guardedApi });
      const t = convexTest(undefined, {
        ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
        "./mock-backend/fixtures/convex/http.ts": () =>
          Promise.resolve({ default: router }),
      });
      const response = yield* Effect.promise(() =>
        t.fetch(path, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "POST" ? { body: '{"value":42}' } : {}),
        }),
      );
      expect([
        response.status,
        yield* Effect.promise(() => response.text()),
      ]).toEqual([expected, ""]);
    }),
);

it.effect(
  "selects preflight middleware by method and keeps explicit OPTIONS",
  () =>
    Effect.gen(function* () {
      const scoped = (method: "GET" | "POST", status: number) =>
        HttpRouter.add(method, "/shared/:id", Effect.die("handler ran")).pipe(
          Layer.provide(
            HttpRouter.middleware((next) =>
              Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
                request.method === "OPTIONS"
                  ? Effect.succeed(HttpServerResponse.empty({ status }))
                  : next,
              ),
            ).layer,
          ),
        );
      const optionsRoutes = Layer.mergeAll(
        scoped("GET", 204),
        scoped("POST", 202),
        HttpRouter.add("GET", "/explicit", Effect.die("handler ran")),
        HttpRouter.add(
          "OPTIONS",
          "/explicit",
          HttpServerResponse.empty({ status: 203 }),
        ),
      );
      const router = ConfectHttpRouter.make(optionsRoutes);
      const t = convexTest(undefined, {
        ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
        "./mock-backend/fixtures/convex/http.ts": () =>
          Promise.resolve({ default: router }),
      });
      for (const [path, method, status] of [
        ["/shared/42", "GET", 204],
        ["/shared/42", "POST", 202],
        ["/shared/42", "DELETE", 404],
        ["/explicit", "GET", 203],
        ["/missing", "GET", 404],
      ] as const) {
        const response = yield* Effect.promise(() =>
          t.fetch(path, {
            method: "OPTIONS",
            headers: { "Access-Control-Request-Method": method },
          }),
        );
        expect(response.status).toBe(status);
      }
    }),
);

it.effect.each([
  { kind: "unguarded", method: "DELETE", path: "/items/42" },
  { kind: "pass-through", method: "POST", path: "/trigger" },
  { kind: "plain", method: "POST", path: "/webhook" },
] as const)(
  "keeps implicit OPTIONS from invoking $kind handlers",
  ({ kind, method, path }) =>
    Effect.gen(function* () {
      let calls = 0;
      const optionsApi = HttpApi.make("options").add(
        HttpApiGroup.make("trigger").add(
          kind === "pass-through"
            ? HttpApiEndpoint.post("run", "/trigger", {
                success: Schema.String,
              }).middleware(Guard)
            : HttpApiEndpoint.delete("run", "/items/:id", {
                params: { id: Schema.String },
                success: Schema.String,
              }),
        ),
      );
      const run = Effect.sync(() => {
        calls++;
        return "handler ran";
      });
      const router =
        kind === "plain"
          ? ConfectHttpRouter.make(
              HttpRouter.add(
                method,
                path,
                Effect.map(run, HttpServerResponse.text),
              ),
            )
          : ConfectHttpRouter.make(
              HttpApiBuilder.layer(optionsApi).pipe(
                Layer.provide(
                  HttpApiBuilder.group(optionsApi, "trigger", (handlers) =>
                    handlers.handle("run", () => run),
                  ),
                ),
                Layer.provide(Layer.succeed(Guard, (next) => next)),
              ),
              { api: optionsApi },
            );
      const t = convexTest(undefined, {
        ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
        "./mock-backend/fixtures/convex/http.ts": () =>
          Promise.resolve({ default: router }),
      });
      const missing = yield* Effect.promise(() =>
        t.fetch("/missing", { method: "OPTIONS" }),
      );
      const headers = [...missing.headers];
      const body = yield* Effect.promise(() => missing.text());
      for (const requestHeaders of [
        {},
        { "Access-Control-Request-Method": method },
      ]) {
        const response = yield* Effect.promise(() =>
          t.fetch(path, { method: "OPTIONS", headers: requestHeaders }),
        );
        expect([
          response.status,
          [...response.headers],
          yield* Effect.promise(() => response.text()),
          calls,
        ]).toEqual([404, headers, body, 0]);
      }
      const response = yield* Effect.promise(() => t.fetch(path, { method }));
      expect(response.status).toBe(200);
      expect(calls).toBe(1);
    }),
);
