import { recording } from "./internal/recording";
import * as IdScope from "@confect/core/IdScope";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import type * as DataModel from "@confect/server/DataModel";
import type * as VectorSearch from "@confect/server/VectorSearch";
import * as ConfectHttpRouter from "@confect/server/HttpRouter";
import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import { vi } from "vitest";
import { convexTest } from "convex-test";
import { httpActionGeneric } from "convex/server";
import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as ByteSize from "effect/ByteSize";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Tracer from "effect/Tracer";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";

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
  Arr.map(router.getRoutes(), ([path, method]) => [method, path]);

const matchLabel = (
  router: ReturnType<typeof ConfectHttpRouter.make>,
  path: string,
  method: "GET" | "POST" | "HEAD" = "GET",
) => router.lookup(path, method)?.slice(1);

it("requires a database schema and types vector search by it", () => {
  const health = HttpRouter.add("GET", "/", HttpServerResponse.text("ok"));
  const schemaless = () =>
    // @ts-expect-error A router takes its database schema first.
    ConfectHttpRouter.make(health);
  void schemaless;
  const empty = DatabaseSchema.make({});
  expectTypeOf<
    VectorSearch.VectorSearch<DataModel.FromSchema<typeof empty>>
  >().toExtend<ConfectHttpRouter.Services<typeof empty>>();
});

describe("HttpRouter", () => {
  it("lists reflected endpoint methods and patterns without catch-all rows", () => {
    const router = ConfectHttpRouter.make(DatabaseSchema.make({}), routes, {
      api,
    });
    expect(labels(router)).toEqual([
      ["POST", "/users"],
      ["GET", "/users/:id"],
    ]);
  });

  it("labels matching requests and keeps the catch-all for unmatched requests", () => {
    const router = ConfectHttpRouter.make(DatabaseSchema.make({}), routes, {
      api,
    });
    expect(
      matchLabel(
        ConfectHttpRouter.make(DatabaseSchema.make({}), routes),
        "/nope",
      ),
    ).toEqual(["GET", "/*"]);
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
    const router = ConfectHttpRouter.make(DatabaseSchema.make({}), routes, {
      api,
    });
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
      ["POST", "/users"],
      ["GET", "/users/:id"],
    ]);
  });

  it("keeps catch-all labels for plain Effect routes beside an API", () => {
    const router = ConfectHttpRouter.make(
      DatabaseSchema.make({}),
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
  const router = ConfectHttpRouter.make(schema, routes, { api });
  expect(labels(router)).toEqual([
    ["POST", "/users"],
    ["GET", "/users/:id"],
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
  const router = ConfectHttpRouter.make(schema, prefixedRoutes, {
    api: prefixedApi,
  });
  expect(matchLabel(router, "/v1/users/42")).toEqual(["GET", "/v1/users/:id"]);
  expect(router.lookup("/nope", "GET")?.slice(1)).toEqual(["GET", "/*"]);
  expect(
    ConfectHttpRouter.make(schema, prefixedRoutes)
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
  const router = ConfectHttpRouter.make(DatabaseSchema.make({}), assetsRoutes, {
    api: assetsApi,
  });
  expect(labels(router)).toEqual([["GET", "/v1/assets/*"]]);
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
  const router = ConfectHttpRouter.make(
    DatabaseSchema.make({}),
    actionsRoutes,
    { api: actionsApi },
  );
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
  const router = ConfectHttpRouter.make(
    schema,
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
    const router = ConfectHttpRouter.make(schema, routes, {
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
      Arr.map(spans, (span) => [
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
      const denied = Denied.make({});
      const forbidden = HttpApiError.Forbidden.make({});
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
      const router = ConfectHttpRouter.make(
        DatabaseSchema.make({}),
        outcomeRoutes,
        {
          api: outcomeApi,
          observability,
        },
      );
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
            default: ConfectHttpRouter.make(
              DatabaseSchema.make({}),
              outcomeRoutes,
              { api: outcomeApi },
            ),
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
        expect(Arr.map(reports, ({ cause }) => Cause.squash(cause))).toEqual(
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
        DatabaseSchema.make({}),
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
const fetcher = (router: ReturnType<typeof ConfectHttpRouter.make>) => {
  const t = convexTest(undefined, {
    ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
    "./mock-backend/fixtures/convex/http.ts": () =>
      Promise.resolve({ default: router }),
  });
  return (path: string, method: string, requested?: string) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        t.fetch(path, {
          method,
          headers:
            requested === undefined
              ? {}
              : { "Access-Control-Request-Method": requested },
        }),
      );
      const body = yield* Effect.promise(() => response.text());
      return [response.status, body] as const;
    });
};

class RouteInfo extends Context.Service<
  RouteInfo,
  { readonly target: string }
>()("@confect/server/test/HttpRouter.test/RouteInfo") {}
class Answer extends HttpApiMiddleware.Service<Answer>()("Answer") {}
class Pass extends HttpApiMiddleware.Service<Pass>()("Pass") {}

it.effect(
  "answers OPTIONS through endpoint middleware, never the handler",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const run = Effect.as(
        Effect.sync(() => calls++),
        "handler ran",
      );
      const optionsApi = HttpApi.make("options")
        .add(
          HttpApiGroup.make("endpoints").add(
            HttpApiEndpoint.post("probe", "/probe", {
              payload: Schema.Struct({ value: Schema.String }),
              success: Schema.String,
            })
              .annotate(RouteInfo, { target: "probe" })
              .middleware(Answer),
            HttpApiEndpoint.post("trigger", "/trigger", {
              success: Schema.String,
            }).middleware(Pass),
            HttpApiEndpoint.delete("remove", "/items/:id", {
              params: { id: Schema.String },
              success: Schema.String,
            }),
            HttpApiEndpoint.get("read", "/read", { success: Schema.String }),
            HttpApiEndpoint.post("raw", "/raw").middleware(Pass),
          ),
        )
        .add(
          HttpApiGroup.make("grouped")
            .add(
              HttpApiEndpoint.post("run", "/grouped", {
                success: Schema.String,
              }),
            )
            .middleware(Pass),
        );
      const send = fetcher(
        ConfectHttpRouter.make(
          DatabaseSchema.make({}),
          HttpApiBuilder.layer(optionsApi).pipe(
            Layer.provide([
              HttpApiBuilder.group(optionsApi, "endpoints", (handlers) =>
                handlers
                  .handle("probe", () => run)
                  .handle("trigger", () => run)
                  .handle("remove", () => run)
                  .handle("read", () => run)
                  .handleRaw("raw", () =>
                    Effect.map(run, HttpServerResponse.text),
                  ),
              ),
              HttpApiBuilder.group(optionsApi, "grouped", (handlers) =>
                handlers.handle("run", () => run),
              ),
            ]),
            Layer.provide([
              Layer.succeed(Pass, (next) => next),
              Layer.succeed(Answer, (_next, { endpoint }) =>
                Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
                  HttpServerResponse.empty({
                    status:
                      Context.getUnsafe(endpoint.annotations, RouteInfo)
                        .target !== "probe"
                        ? 500
                        : request.method === "OPTIONS"
                          ? 204
                          : 401,
                  }),
                ),
              ),
            ]),
          ),
          { api: optionsApi },
        ),
      );
      expect(yield* send("/probe", "POST")).toEqual([401, ""]);
      expect(yield* send("/probe", "OPTIONS")).toEqual([204, ""]);
      for (const [path, method] of [
        ["/trigger", undefined],
        ["/trigger", "POST"],
        ["/items/42", "DELETE"],
        ["/read", "GET"],
        ["/read", "HEAD"],
        ["/raw", "POST"],
        ["/grouped", "POST"],
        ["/missing", undefined],
      ] as const)
        expect(yield* send(path, "OPTIONS", method)).toEqual([404, ""]);
      expect(calls).toBe(0);
      expect(yield* send("/trigger", "POST")).toEqual([200, '"handler ran"']);
      expect(calls).toBe(1);
    }),
);

const answering = (
  method: "GET" | "HEAD" | "POST" | "PUT",
  path: `/${string}`,
  prefix?: string,
) =>
  HttpRouter.addAll(
    [HttpRouter.route(method, path, HttpServerResponse.text(`${method} ran`))],
    { prefix },
  ).pipe(
    Layer.provide(
      HttpRouter.middleware((next) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "OPTIONS") return yield* next;
          const params = Record.toEntries(yield* HttpRouter.params).flat();
          return HttpServerResponse.text(
            Arr.join([method, ...Arr.map(params, (param) => param ?? "")], " "),
          );
        }),
      ).layer,
    ),
  );

it.effect.each([
  {
    paths: "with differently named parameters",
    layer: Layer.mergeAll(
      answering("GET", "/shared/:id"),
      answering("POST", "/shared/:slug"),
      HttpRouter.add("POST", "/webhook", HttpServerResponse.text("ran")),
    ),
    request: ["GET", "/shared/7", "GET ran"],
    preflights: [
      ["/shared/7", "GET", 200, "GET id 7"],
      ["/shared/7", "POST", 200, "POST slug 7"],
      ["/shared/7", undefined, 200, "GET id 7"],
      ["/shared/7", "DELETE", 404, ""],
      ["/webhook", "POST", 404, ""],
      ["/missing", "GET", 404, ""],
    ],
  },
  {
    paths: "differing in trailing slash and case",
    layer: Layer.mergeAll(
      answering("GET", "/trailing"),
      answering("POST", "/trailing/"),
      answering("PUT", "/Trailing"),
    ),
    request: ["POST", "/trailing", "POST ran"],
    preflights: [
      ["/trailing", "POST", 200, "POST"],
      ["/TRAILING/", "PUT", 200, "PUT"],
      ["/trailing", undefined, 200, "GET"],
    ],
  },
  {
    paths: "requesting HEAD, which GET answers where no HEAD route matches",
    layer: Layer.mergeAll(
      answering("GET", "/head/:id"),
      answering("HEAD", "/wild/*"),
      answering("GET", "/wild/:id"),
    ),
    request: ["HEAD", "/head/7", ""],
    preflights: [
      ["/head/7", "HEAD", 200, "GET id 7"],
      ["/wild/7", "HEAD", 200, "HEAD * 7"],
    ],
  },
  {
    paths: "with an optional parameter whose full form an earlier route claims",
    layer: Layer.mergeAll(
      answering("GET", "/optional/:id"),
      answering("POST", "/optional/:slug?"),
    ),
    request: ["POST", "/optional", "POST ran"],
    preflights: [
      ["/optional", undefined, 200, "POST"],
      ["/optional/7", undefined, 200, "GET id 7"],
    ],
  },
  {
    paths:
      "under a prefix with an optional parameter whose full form is claimed",
    layer: Layer.mergeAll(
      answering("GET", "/prefix/:id"),
      answering("POST", "/", "/prefix/:slug?"),
    ),
    request: ["POST", "/prefix", "POST ran"],
    preflights: [
      ["/prefix", undefined, 200, "POST"],
      ["/prefix", "POST", 200, "POST"],
      ["/prefix/7", undefined, 200, "GET id 7"],
    ],
  },
  {
    paths: "beside an explicit OPTIONS route with another parameter name",
    layer: Layer.mergeAll(
      answering("GET", "/shared/:id"),
      HttpRouter.add(
        "OPTIONS",
        "/shared/:slug",
        HttpServerResponse.text("OPTIONS"),
      ),
    ),
    request: ["GET", "/shared/7", "GET ran"],
    preflights: [
      ["/shared/7", "GET", 200, "OPTIONS"],
      ["/shared/7", undefined, 200, "OPTIONS"],
    ],
  },
  {
    paths: "under a catch-all route",
    layer: Layer.mergeAll(
      answering("GET", "/shared/:id"),
      HttpRouter.add("*", "*", HttpServerResponse.text("fallback")),
    ),
    request: ["GET", "/shared/7", "GET ran"],
    preflights: [["/shared/7", "GET", 200, "fallback"]],
  },
] as const)(
  "dispatches OPTIONS on router-equivalent paths $paths",
  ({ layer, request, preflights }) =>
    Effect.gen(function* () {
      const send = fetcher(
        ConfectHttpRouter.make(DatabaseSchema.make({}), layer),
      );
      const [method, path, body] = request;
      expect(yield* send(path, method)).toEqual([200, body]);
      for (const [preflightPath, requested, ...expected] of preflights)
        expect(yield* send(preflightPath, "OPTIONS", requested)).toEqual(
          expected,
        );
    }),
);

class Guard extends HttpApiMiddleware.Service<Guard>()("Guard") {}
class BodyLimit extends Context.Service<BodyLimit, ByteSize.ByteSize>()(
  "@confect/server/test/HttpRouter.test/BodyLimit",
) {}

it.effect(
  "shares counted bytes between a verifier and the payload decoder",
  () =>
    Effect.gen(function* () {
      const bodyApi = HttpApi.make("body").add(
        HttpApiGroup.make("body").add(
          HttpApiEndpoint.post("run", "/body", {
            payload: Schema.Struct({ value: Schema.String }),
            success: Schema.String,
          })
            .annotate(BodyLimit, ByteSize.bytes(64))
            .middleware(Guard),
          HttpApiEndpoint.post("json", "/json", {
            payload: Schema.Struct({ value: Schema.String }),
            success: Schema.String,
          })
            .annotate(BodyLimit, ByteSize.bytes(64))
            .middleware(Guard),
          HttpApiEndpoint.post("bytes", "/bytes", {
            payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
            success: Schema.String,
          })
            .annotate(BodyLimit, ByteSize.bytes(64))
            .middleware(Guard),
        ),
      );
      const bodyRoutes = HttpApiBuilder.layer(bodyApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(bodyApi, "body", (h) =>
            h
              .handle("run", ({ payload }) => Effect.succeed(payload.value))
              .handle("json", ({ payload }) => Effect.succeed(payload.value))
              .handle("bytes", ({ payload }) =>
                Effect.succeed(new TextDecoder().decode(payload)),
              ),
          ),
        ),
        Layer.provide(
          Layer.succeed(Guard, (next, { endpoint }) =>
            ConfectHttpRouter.withBodyLimit(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                // The bytes verifier consumes the stream before its decoder
                // reads arrayBuffer.
                let text: string;
                if (
                  endpoint.identifier === "bytes" ||
                  endpoint.identifier === "json"
                ) {
                  text = yield* request.stream.pipe(
                    Stream.decodeText(),
                    Stream.mkString,
                    Effect.orDie,
                  );
                } else {
                  const first = yield* request.arrayBuffer.pipe(Effect.orDie);
                  const second = yield* request.arrayBuffer.pipe(Effect.orDie);
                  expect(first).toBe(second);
                  text = new TextDecoder().decode(first);
                }
                if (text !== '{"value":"signed"}')
                  return HttpServerResponse.empty({ status: 401 });
                return yield* next;
              }),
              { maxBytes: Context.getUnsafe(endpoint.annotations, BodyLimit) },
            ),
          ),
        ),
      );
      const router = ConfectHttpRouter.make(
        DatabaseSchema.make({}),
        bodyRoutes,
        { api: bodyApi },
      );
      const t = convexTest(undefined, {
        ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
        "./mock-backend/fixtures/convex/http.ts": () =>
          Promise.resolve({ default: router }),
      });
      for (const [path, body, encoding, status, result] of [
        ["/body", '{"value":"signed"}', "identity", 200, '"signed"'],
        ["/body", '{"value":"changed"}', "identity", 401, ""],
        ["/body", '{"value":"signed"}', "gzip", 415, ""],
        ["/body", pipe("x", Str.repeat(65)), "identity", 413, ""],
        ["/json", '{"value":"signed"}', "identity", 200, '"signed"'],
        ["/json", '{"value":"changed"}', "identity", 401, ""],
        [
          "/bytes",
          '{"value":"signed"}',
          "identity",
          200,
          '"{\\"value\\":\\"signed\\"}"',
        ],
        ["/bytes", '{"value":"changed"}', "identity", 401, ""],
      ] as const) {
        const response = yield* Effect.promise(() =>
          t.fetch(path, {
            method: "POST",
            headers: {
              "Content-Type":
                path === "/body" || path === "/json"
                  ? "application/json"
                  : "application/octet-stream",
              "Content-Encoding": encoding,
            },
            body,
          }),
        );
        expect([
          response.status,
          yield* Effect.promise(() => response.text()),
        ]).toEqual([status, result]);
      }
    }),
);

it.effect("stops a chunked body after the cap and one transport chunk", () =>
  Effect.gen(function* () {
    let pulled = 0;
    let cancelled = false;
    const source = new Request("http://localhost/body", {
      method: "POST",
      duplex: "half",
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled += 65536;
            controller.enqueue(new Uint8Array(65536));
            if (pulled === 2097152) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    } as RequestInit & { duplex: "half" });
    const response = yield* ConfectHttpRouter.withBodyLimit(
      Effect.succeed(HttpServerResponse.empty()),
      { maxBytes: ByteSize.mebibytes(1) },
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(source),
      ),
    );
    expect([response.status, pulled, cancelled]).toEqual([
      413,
      1048576 + 65536,
      true,
    ]);
    pulled = 0;
    const encoded = yield* ConfectHttpRouter.withBodyLimit(
      Effect.succeed(HttpServerResponse.empty()),
      { maxBytes: ByteSize.mebibytes(1) },
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(source.url, {
            method: "POST",
            headers: { "Content-Encoding": "gzip" },
            duplex: "half",
            body: new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulled += 65536;
                  controller.enqueue(new Uint8Array(65536));
                },
              },
              { highWaterMark: 0 },
            ),
          } as RequestInit & { duplex: "half" }),
        ),
      ),
    );
    expect([encoded.status, pulled]).toEqual([415, 0]);
  }),
);

it.effect(
  "refuses a declared length over the cap without reading the body",
  () =>
    Effect.gen(function* () {
      let pulled = 0;
      const source = new Request("http://localhost/body", {
        method: "POST",
        headers: { "Content-Length": String(ByteSize.mebibytes(2)) },
        duplex: "half",
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulled += 65536;
              controller.enqueue(new Uint8Array(65536));
            },
          },
          { highWaterMark: 0 },
        ),
      } as RequestInit & { duplex: "half" });
      const response = yield* ConfectHttpRouter.withBodyLimit(
        Effect.succeed(HttpServerResponse.empty()),
        { maxBytes: ByteSize.mebibytes(1) },
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(source),
        ),
      );
      expect([response.status, pulled]).toEqual([413, 0]);
    }),
);

it("requires a byte size and preserves the downstream error type", () => {
  const limited = ConfectHttpRouter.withBodyLimit(
    Effect.fail(HttpApiError.Unauthorized.make({})),
    { maxBytes: ByteSize.bytes(1) },
  );
  expectTypeOf(limited).toEqualTypeOf<
    Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      HttpApiError.Unauthorized,
      HttpServerRequest.HttpServerRequest
    >
  >();
  // @ts-expect-error A limit must use Effect's ByteSize type.
  const invalid = ConfectHttpRouter.withBodyLimit(Effect.void, { maxBytes: 1 });
  expectTypeOf(invalid).not.toBeNever();
});
