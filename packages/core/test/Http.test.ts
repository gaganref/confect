import { describe, expect, it } from "@effect/vitest";
import { App, Env, Http } from "@confect/core";
import { defineComponent } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as OpenApi from "effect/http-api/OpenApi";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

const counter = defineComponent("counter");
const workpool = defineComponent("workpool");

const CounterApi = HttpApi.make("counter").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("health", "/health", { success: Schema.String }),
    HttpApiEndpoint.post("echo", "/echo", { success: Schema.String }),
  ),
);

const app = App.make({
  env: Env.make("host", {}),
  mounts: {
    first: App.mount(counter, { httpPrefix: "/first", api: CounterApi }),
    second: App.mount(counter, { httpPrefix: "/second/", api: CounterApi }),
    pool: App.mount(workpool),
  },
});

const hostApi = (path: `/${string}`) =>
  HttpApi.make("host").add(
    HttpApiGroup.make("meta").add(
      HttpApiEndpoint.get("route", path, { success: Schema.String }),
    ),
  );

const handlers = (api: ReturnType<typeof hostApi>) =>
  HttpApiBuilder.group(api, "meta", (h) =>
    h.handle("route", () => Effect.succeed("ok")),
  );

const declare = (path: `/${string}`, docs?: `/${string}`) => {
  const api = hostApi(path);
  return Http.make({
    api,
    handlers: handlers(api),
    ...(docs === undefined ? {} : { docs }),
  });
};

describe("Http", () => {
  it.effect(
    "serves CDN docs with escaped API metadata and a live endpoint",
    () => {
      const api = hostApi("/meta")
        .annotate(OpenApi.Title, "A < B & C")
        .annotate(OpenApi.Description, '"quoted" </script>');
      const http = Http.make({ api, handlers: handlers(api), docs: "/docs" });
      return Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            http.routes.pipe(Layer.provide(HttpServer.layerServices)),
            { disableLogger: true },
          ),
        ),
        (web) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              web.handler(new Request("https://example.com/docs")),
            );
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toContain("text/html");
            const body = yield* Effect.promise(() => response.text());
            expect(body).toContain("<title>A &lt; B &amp; C</title>");
            expect(body).toContain(
              'content="&quot;quoted&quot; &lt;/script&gt;"',
            );
            expect(body).toContain("\\u003c/script>");
            expect(body).toContain(
              "https://cdn.jsdelivr.net/npm/@scalar/api-reference@latest/dist/browser/standalone.min.js",
            );
            expect(body).toContain('"/meta"');
            expect(body).toContain("window.Scalar.createApiReference");
            const endpoint = yield* Effect.promise(() =>
              web.handler(new Request("https://example.com/meta")),
            );
            expect(yield* Effect.promise(() => endpoint.text())).toBe('"ok"');
          }),
        (web) => Effect.promise(web.dispose),
      );
    },
  );

  it("lists the app's routes and each mount's prefixed routes", () => {
    expect(Http.routes(app, declare("/context-metadata", "/docs"))).toEqual(
      Result.succeed([
        { method: "GET", path: "/context-metadata", owner: { kind: "app" } },
        { method: "GET", path: "/docs", owner: { kind: "docs" } },
        {
          method: "GET",
          path: "/first/health",
          owner: { kind: "mount", mount: "first" },
        },
        {
          method: "POST",
          path: "/first/echo",
          owner: { kind: "mount", mount: "first" },
        },
        {
          method: "GET",
          path: "/second/health",
          owner: { kind: "mount", mount: "second" },
        },
        {
          method: "POST",
          path: "/second/echo",
          owner: { kind: "mount", mount: "second" },
        },
      ]),
    );
  });

  it("rejects an app route at or under a mount prefix", () => {
    for (const path of ["/first", "/first/", "/first/status"] as const) {
      expect(Http.routes(app, declare(path))).toEqual(
        Result.fail(
          new Http.RouteUnderMountPrefix({
            method: "GET",
            path,
            mount: "first",
            httpPrefix: "/first",
          }),
        ),
      );
    }
    expect(Result.isSuccess(Http.routes(app, declare("/firstly")))).toBe(true);
  });

  it("rejects the docs page under a mount prefix", () => {
    expect(Http.routes(app, declare("/meta", "/second/docs"))).toEqual(
      Result.fail(
        new Http.RouteUnderMountPrefix({
          method: "GET",
          path: "/second/docs",
          mount: "second",
          httpPrefix: "/second",
        }),
      ),
    );
  });

  it("rejects a duplicate method and path after merging mount apis", () => {
    const shared = HttpApi.make("shared").add(
      HttpApiGroup.make("a").add(
        HttpApiEndpoint.get("one", "/items/:id", {
          params: Schema.Struct({ id: Schema.String }),
          success: Schema.String,
        }),
        HttpApiEndpoint.get("two", "/items/:key", {
          params: Schema.Struct({ key: Schema.String }),
          success: Schema.String,
        }),
      ),
    );
    const duplicated = App.make({
      env: Env.make("host", {}),
      mounts: { items: App.mount(counter, { httpPrefix: "/x", api: shared }) },
    });
    expect(Http.routes(duplicated)).toEqual(
      Result.fail(
        new Http.DuplicateRoute({
          method: "GET",
          path: "/x/items/:key",
          first: { kind: "mount", mount: "items" },
          second: { kind: "mount", mount: "items" },
        }),
      ),
    );
  });

  it("keeps literal text after a path parameter distinct", () => {
    const actions = HttpApi.make("actions").add(
      HttpApiGroup.make("a").add(
        HttpApiEndpoint.post("cancel", "/items/:id:cancel", {
          params: Schema.Struct({ id: Schema.String }),
          success: Schema.String,
        }),
        HttpApiEndpoint.post("archive", "/items/:id:archive", {
          params: Schema.Struct({ id: Schema.String }),
          success: Schema.String,
        }),
        HttpApiEndpoint.get("json", "/files/:name.json", {
          params: Schema.Struct({ name: Schema.String }),
          success: Schema.String,
        }),
        HttpApiEndpoint.get("text", "/files/:name.txt", {
          params: Schema.Struct({ name: Schema.String }),
          success: Schema.String,
        }),
      ),
    );
    const distinct = App.make({
      env: Env.make("host", {}),
      mounts: { items: App.mount(counter, { httpPrefix: "/x", api: actions }) },
    });
    expect(Result.isSuccess(Http.routes(distinct))).toBe(true);
  });

  it("rejects mounts whose prefixes overlap, with or without an api", () => {
    const overlapping = App.make({
      env: Env.make("host", {}),
      mounts: {
        outer: App.mount(workpool, { httpPrefix: "/jobs" }),
        inner: App.mount(counter, { httpPrefix: "/jobs/inner" }),
      },
    });
    expect(Http.routes(overlapping)).toEqual(
      Result.fail(
        new Http.OverlappingMountPrefixes({
          first: { mount: "outer", httpPrefix: "/jobs" },
          second: { mount: "inner", httpPrefix: "/jobs/inner" },
        }),
      ),
    );
  });

  it("builds a routes layer for the app's api and its handlers", () => {
    const http = declare("/context-metadata", "/docs");
    expect(Http.isHttp(http)).toBe(true);
    expect(Layer.isLayer(http.routes)).toBe(true);
    expect(http.api).toBeDefined();
  });
});
