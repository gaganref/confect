import { describe, expect, it } from "@effect/vitest";
import { App, Component, Env, Http, Mount } from "@confect/core";
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
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";
import * as Record from "effect/Record";

const components = [defineComponent("counter"), defineComponent("workpool")];
const client = (native: unknown) => native;
const Counter = Component.make("counter", { client });
const Workpool = Component.make("workpool", { client });

const app = App.make({
  env: Env.make("host", {}),
  components,
  mounts: [
    Mount.make(Counter, { name: "first", httpPrefix: "/first" }),
    Mount.make(Counter, { name: "second", httpPrefix: "/second/" }),
    Mount.make(Workpool, { name: "pool" }),
  ],
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
            const effect = HttpRouter.toWebHandler(
              HttpApiScalar.layerCdn(api).pipe(
                Layer.provide(HttpServer.layerServices),
              ),
              { disableLogger: true },
            );
            const expected = yield* Effect.promise(() =>
              effect.handler(new Request("https://example.com/docs")),
            );
            const resolved = yield* Effect.promise(() => expected.text());
            expect(body).toBe(resolved);
            expect(Record.fromEntries(response.headers)).toEqual(
              Record.fromEntries(expected.headers),
            );
            yield* Effect.promise(effect.dispose);
            expect(body).toContain(
              'content="&quot;quoted&quot; &lt;/script&gt;"',
            );
            const endpoint = yield* Effect.promise(() =>
              web.handler(new Request("https://example.com/meta")),
            );
            const resolved2 = yield* Effect.promise(() => endpoint.text());
            expect(resolved2).toBe('"ok"');
          }),
        (web) => Effect.promise(web.dispose),
      );
    },
  );

  it("lists the app's own routes and docs page", () => {
    expect(Http.routes(app, declare("/context-metadata", "/docs"))).toEqual(
      Result.succeed([
        { method: "GET", path: "/context-metadata", owner: { kind: "app" } },
        { method: "GET", path: "/docs", owner: { kind: "docs" } },
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

  it("rejects a duplicate method and path in the app api", () => {
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
    expect(
      Http.routes(
        app,
        Http.make({
          api: shared,
          handlers: HttpApiBuilder.group(shared, "a", (h) =>
            h
              .handle("one", () => Effect.succeed("ok"))
              .handle("two", () => Effect.succeed("ok")),
          ),
        }),
      ),
    ).toEqual(
      Result.fail(
        new Http.DuplicateRoute({
          method: "GET",
          path: "/items/:key",
          first: { kind: "app" },
          second: { kind: "app" },
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
    expect(
      Result.isSuccess(
        Http.routes(
          app,
          Http.make({
            api: actions,
            handlers: HttpApiBuilder.group(actions, "a", (h) =>
              h
                .handle("cancel", () => Effect.succeed("ok"))
                .handle("archive", () => Effect.succeed("ok"))
                .handle("json", () => Effect.succeed("ok"))
                .handle("text", () => Effect.succeed("ok")),
            ),
          }),
        ),
      ),
    ).toBe(true);
  });

  it("rejects mounts whose prefixes overlap", () => {
    const overlapping = App.make({
      env: Env.make("host", {}),
      components,
      mounts: [
        Mount.make(Workpool, { name: "outer", httpPrefix: "/jobs" }),
        Mount.make(Counter, { name: "inner", httpPrefix: "/jobs/inner" }),
      ],
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
