import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
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

  it.effect.each([
    {
      file: "../src/Http.ts",
      block: /\* The URL of one[\s\S]*?```ts\n([\s\S]*?)```/,
    },
    {
      file: "../../../apps/docs/server/http-api.mdx",
      block: /## Get an endpoint's public URL[\s\S]*?```ts\n([\s\S]*?)```/,
    },
  ])("documents URL yielding inside a generator in $file", ({ file, block }) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(NodeServices.layer);
      const fs = yield* FileSystem.FileSystem.pipe(
        Effect.provideContext(services),
      );
      const source = yield* fs.readFileString(
        new URL(file, import.meta.url).pathname,
      );
      const example = pipe(source, Str.match(block), Option.getOrThrow)[1];
      expect(example).toContain("Effect.gen(function* () {");
      expect(example).toContain("yield* Http.url(");
      expect(example).not.toContain("yield *");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "builds an endpoint's URL from the site URL Convex gives the mount",
    () =>
      Effect.gen(function* () {
        const Api = HttpApi.make("email").add(
          HttpApiGroup.make("webhooks")
            .add(
              HttpApiEndpoint.post("resend", "/webhooks/resend", {
                success: Schema.String,
              }),
            )
            .add(
              HttpApiEndpoint.get("byId", "/webhooks/:id", {
                success: Schema.String,
                params: { id: Schema.String },
              }),
            ),
        );
        const services = yield* ConfigProvider.fromUnknown({
          CONVEX_SITE_URL: "https://happy-otter-123.convex.site/relay/email/",
        }).pipe(ConfigProvider.layer, Layer.build);
        const url = yield* Http.url(Api, "webhooks", "resend").pipe(
          Effect.provideContext(services),
        );
        expect(url).toBe(
          "https://happy-otter-123.convex.site/relay/email/webhooks/resend",
        );
        const refused = () => [
          // @ts-expect-error An endpoint with a path parameter names no single URL.
          Http.url(Api, "webhooks", "byId"),
          // @ts-expect-error The api has no group named "hooks".
          Http.url(Api, "hooks", "resend"),
          // @ts-expect-error The group has no endpoint named "sent".
          Http.url(Api, "webhooks", "sent"),
        ];
        void refused;
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    [
      "https://happy-otter-123.convex.site",
      "https://happy-otter-123.convex.site/webhooks/resend",
    ],
    [
      "https://happy-otter-123.convex.site/",
      "https://happy-otter-123.convex.site/webhooks/resend",
    ],
    [
      "https://happy-otter-123.convex.site/relay/email",
      "https://happy-otter-123.convex.site/relay/email/webhooks/resend",
    ],
    [
      "https://happy-otter-123.convex.site/relay/email/",
      "https://happy-otter-123.convex.site/relay/email/webhooks/resend",
    ],
    [
      "https://happy-otter-123.convex.site//",
      "https://happy-otter-123.convex.site/webhooks/resend",
    ],
    [
      "https://happy-otter-123.convex.site/relay/email//",
      "https://happy-otter-123.convex.site/relay/email/webhooks/resend",
    ],
  ])("joins absolute and relative endpoint paths to %s", ([site, expected]) =>
    Effect.gen(function* () {
      const services = yield* ConfigProvider.fromUnknown({
        CONVEX_SITE_URL: site,
      }).pipe(ConfigProvider.layer, Layer.build);
      for (const endpoint of [
        HttpApiEndpoint.post("resend", "/webhooks/resend"),
        // @ts-expect-error Effect constructors require absolute paths; exercise a relative path from an untyped caller.
        HttpApiEndpoint.post("resend", "webhooks/resend"),
      ]) {
        const api = HttpApi.make("email").add(
          HttpApiGroup.make("webhooks").add(endpoint),
        );
        const url = yield* Http.url(api, "webhooks", "resend").pipe(
          Effect.provideContext(services),
        );
        expect(url).toBe(expected);
      }
    }).pipe(Effect.scoped),
  );

  it.effect.each(["not-a-url", "undefined", "   ", undefined, ""])(
    "rejects invalid or absent site URL %j with ConfigError",
    (site) =>
      Effect.gen(function* () {
        const api = HttpApi.make("hooks").add(
          HttpApiGroup.make("webhooks").add(
            HttpApiEndpoint.post("resend", "/hooks"),
          ),
        );
        const services = yield* ConfigProvider.fromUnknown(
          site === undefined ? {} : { CONVEX_SITE_URL: site },
        ).pipe(ConfigProvider.layer, Layer.build);
        const result = yield* Http.url(api, "webhooks", "resend").pipe(
          Effect.result,
          Effect.provideContext(services),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(Config.ConfigError);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("keeps API and group prefixes after the mount prefix", () =>
    Effect.gen(function* () {
      class Webhooks extends HttpApiGroup.make("webhooks")
        .add(HttpApiEndpoint.post("resend", "/resend"))
        .prefix("/webhooks") {}
      class EmailApi extends HttpApi.make("email")
        .add(Webhooks)
        .prefix("/v1") {}
      const services = yield* ConfigProvider.fromUnknown({
        CONVEX_SITE_URL: "https://happy-otter-123.convex.site/relay/email",
      }).pipe(ConfigProvider.layer, Layer.build);
      const url = yield* Http.url(EmailApi, "webhooks", "resend").pipe(
        Effect.provideContext(services),
      );
      expect(url).toBe(
        "https://happy-otter-123.convex.site/relay/email/v1/webhooks/resend",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("resolves a shared endpoint name within its own group", () =>
    Effect.gen(function* () {
      const api = HttpApi.make("shared").add(
        HttpApiGroup.make("webhooks").add(
          HttpApiEndpoint.post("receive", "/hooks"),
        ),
        HttpApiGroup.make("files").add(
          HttpApiEndpoint.post("receive", "/uploads"),
        ),
      );
      const services = yield* ConfigProvider.fromUnknown({
        CONVEX_SITE_URL: "https://happy-otter-123.convex.site/relay",
      }).pipe(ConfigProvider.layer, Layer.build);
      const hooks = yield* Http.url(api, "webhooks", "receive").pipe(
        Effect.provideContext(services),
      );
      const files = yield* Http.url(api, "files", "receive").pipe(
        Effect.provideContext(services),
      );
      expect(hooks).toBe("https://happy-otter-123.convex.site/relay/hooks");
      expect(files).toBe("https://happy-otter-123.convex.site/relay/uploads");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    ["missing", "receive"],
    ["webhooks", "missing"],
  ] as const)("reports unknown %s.%s through Config", ([group, endpoint]) =>
    Effect.gen(function* () {
      const api = HttpApi.make("shared").add(
        HttpApiGroup.make("webhooks").add(
          HttpApiEndpoint.post("receive", "/hooks"),
        ),
      );
      const services = yield* ConfigProvider.fromUnknown({
        CONVEX_SITE_URL: "https://happy-otter-123.convex.site",
      }).pipe(ConfigProvider.layer, Layer.build);
      // @ts-expect-error Exercise invalid names supplied by an untyped caller.
      const config = Http.url(api, group, endpoint);
      expectTypeOf(config).toEqualTypeOf<Config.Config<string>>();
      const result = yield* config.pipe(
        Effect.result,
        Effect.provideContext(services),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(Config.ConfigError);
        expect(result.failure.message).toContain(group);
        expect(result.failure.message).toContain(endpoint);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reports an endpoint absent from a group selected by a union", () =>
    Effect.gen(function* () {
      const api = HttpApi.make("shared").add(
        HttpApiGroup.make("webhooks").add(
          HttpApiEndpoint.post("receive", "/hooks"),
        ),
        HttpApiGroup.make("files").add(
          HttpApiEndpoint.post("upload", "/uploads"),
        ),
      );
      const selectGroup = (): "webhooks" | "files" => "files";
      const config = Http.url(api, selectGroup(), "receive");
      const services = yield* ConfigProvider.fromUnknown({
        CONVEX_SITE_URL: "https://happy-otter-123.convex.site",
      }).pipe(ConfigProvider.layer, Layer.build);
      const result = yield* config.pipe(
        Effect.result,
        Effect.provideContext(services),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(Config.ConfigError);
        expect(result.failure.message).toContain("files");
        expect(result.failure.message).toContain("receive");
      }
    }).pipe(Effect.scoped),
  );

  it("types endpoint addresses against their own group", () => {
    const api = HttpApi.make("email").add(
      HttpApiGroup.make("webhooks").add(
        HttpApiEndpoint.post("resend", "/webhooks/resend"),
      ),
      HttpApiGroup.make("admin").add(HttpApiEndpoint.get("status", "/status")),
    );
    expectTypeOf(Http.url(api, "webhooks", "resend")).toEqualTypeOf<
      Config.Config<string>
    >();
    expectTypeOf(Http.url(api, "admin", "status")).toEqualTypeOf<
      Config.Config<string>
    >();
    const refused = () => [
      // @ts-expect-error The endpoint belongs to another group.
      Http.url(api, "webhooks", "status"),
    ];
    void refused;
  });

  it("refuses wildcard and parameterized addresses at every prefix", () => {
    const wildcards = HttpApi.make("wildcards").add(
      HttpApiGroup.make("webhooks").add(
        HttpApiEndpoint.get("any", "*"),
        HttpApiEndpoint.get("files", "/files/*"),
      ),
    );
    const groupWildcard = HttpApi.make("groupWildcard").add(
      HttpApiGroup.make("webhooks")
        .add(HttpApiEndpoint.get("resend", "/resend"))
        .prefix("/files/*"),
    );
    const apiWildcard = HttpApi.make("apiWildcard")
      .add(
        HttpApiGroup.make("webhooks").add(
          HttpApiEndpoint.get("resend", "/resend"),
        ),
      )
      .prefix("/files/*");
    const groupParameter = HttpApi.make("groupParameter").add(
      HttpApiGroup.make("webhooks")
        .add(HttpApiEndpoint.get("resend", "/resend"))
        .prefix("/files/:id"),
    );
    const apiParameter = HttpApi.make("apiParameter")
      .add(
        HttpApiGroup.make("webhooks").add(
          HttpApiEndpoint.get("resend", "/resend"),
        ),
      )
      .prefix("/files/:id");
    const refused = () => [
      // @ts-expect-error A bare wildcard names no single URL.
      Http.url(wildcards, "webhooks", "any"),
      // @ts-expect-error An endpoint wildcard names no single URL.
      Http.url(wildcards, "webhooks", "files"),
      // @ts-expect-error A group prefix wildcard names no single URL.
      Http.url(groupWildcard, "webhooks", "resend"),
      // @ts-expect-error An API prefix wildcard names no single URL.
      Http.url(apiWildcard, "webhooks", "resend"),
      // @ts-expect-error A group prefix parameter names no single URL.
      Http.url(groupParameter, "webhooks", "resend"),
      // @ts-expect-error An API prefix parameter names no single URL.
      Http.url(apiParameter, "webhooks", "resend"),
    ];
    void refused;
  });

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
          Http.RouteUnderMountPrefix.make({
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
        Http.RouteUnderMountPrefix.make({
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
        Http.DuplicateRoute.make({
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
        Http.OverlappingMountPrefixes.make({
          first: { mount: "outer", httpPrefix: "/jobs" },
          second: { mount: "inner", httpPrefix: "/jobs/inner" },
        }),
      ),
    );
  });

  it("skips the holes in a sparse list of mounts", () => {
    const mounts: Array<Mount.Any> = [];
    mounts[1] = Mount.make(Workpool, { name: "outer", httpPrefix: "/jobs" });
    mounts[2] = Mount.make(Counter, {
      name: "inner",
      httpPrefix: "/jobs/inner",
    });
    const sparse = App.make({ env: Env.make("host", {}), components, mounts });
    expect(Http.routes(sparse)).toEqual(
      Result.fail(
        Http.OverlappingMountPrefixes.make({
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
