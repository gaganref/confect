import * as IdScope from "@confect/core/IdScope";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as ConfectHttpRouter from "@confect/server/HttpRouter";
import { describe, expect, it } from "@effect/vitest";
import { httpActionGeneric } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

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
        .handle("get", ({ params }) => Effect.succeed(params.id))
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
      ["POST", "/users"],
      ["GET", "/users/:id"],
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
      ["POST", "/users"],
      ["GET", "/users/:id"],
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
