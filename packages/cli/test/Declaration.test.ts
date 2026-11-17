import { describe, expect, it } from "@effect/vitest";
import { App, Auth, Component, Env, Mount } from "@confect/core";
import * as Declaration from "@confect/cli/Declaration";
import { defineComponent } from "convex/server";
import { v } from "convex/values";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Array from "effect/Array";
import { assertIs } from "./internal/assertIs";

const ratelimiter = defineComponent("ratelimiter", {
  env: { LIMIT: v.string() },
});
const workpool = defineComponent("workpool");
const Ratelimiter = Component.make("ratelimiter", {
  env: { LIMIT: Schema.String },
  client: (native: unknown) => native,
});
const Workpool = Component.make("workpool", {
  client: (native: unknown) => native,
});
const Limiter = Mount.make(Ratelimiter, { name: "limiter" });
const componentImport = (definition: unknown) =>
  Predicate.hasProperty(definition, "_name") &&
  Predicate.isString(definition._name)
    ? Option.some({
        importPath: `@convex-dev/${definition._name}/convex.config.js`,
        componentName: definition._name,
      })
    : Option.none();
const parseApp = (app: unknown) =>
  Declaration.parse({
    target: "app",
    app,
    auth: Option.none(),
    componentImport,
  });

const formatOne = {
  format: 1,
  sections: {},
  name: "workpool",
  env: {},
  mounts: {},
  http: {},
  digest: "sha256:child",
} as const;
const invalidManifests: ReadonlyArray<readonly [string, unknown]> = [
  [
    "missing format",
    {
      name: "workpool",
      sections: {},
      env: {},
      mounts: {},
      http: {},
      digest: "sha256:child",
    },
  ],
  ...Array.map(
    [0, 2, "1"],
    (format) => [`format ${format}`, { ...formatOne, format }] as const,
  ),
  ["extra root field", { ...formatOne, extra: true }],
  [
    "extra nested field",
    {
      ...formatOne,
      env: { KEY: { kind: "string", optional: false, extra: true } },
    },
  ],
  [
    "missing mounts",
    {
      format: 1,
      name: "workpool",
      sections: {},
      env: {},
      http: {},
      digest: "sha256:child",
    },
  ],
  [
    "missing digest",
    {
      format: 1,
      name: "workpool",
      sections: {},
      env: {},
      mounts: {},
      http: {},
    },
  ],
  ["null", null],
  [
    "unknown kind",
    { ...formatOne, env: { KEY: { kind: "future", optional: false } } },
  ],
  [
    "PR 168 shape",
    {
      format: 1,
      sections: {},
      name: "workpool",
      env: {},
      http: { mounts: { pool: "/pool" } },
      digest: "sha256:child",
    },
  ],
  ["PR 170 shape", { ...formatOne, http: { mounts: { pool: "/pool" } } }],
];

describe("Declaration", () => {
  it.each(invalidManifests)(
    "refuses a malformed mounted manifest (%s) before reading slots",
    (_, manifest) => {
      const component = Component.make("workpool", {
        manifest: manifest as typeof formatOne,
        client: (native: unknown) => native,
      });
      const parsed = parseApp(
        App.make({
          env: Env.make("host", {}),
          components: [workpool],
          mounts: [Mount.make(component, { name: "pool" })],
        }),
      );
      assertIs(parsed, Result.isFailure);
      expect(parsed.failure).toMatchObject({
        _tag: "UnsupportedManifestFormat",
        source: "@convex-dev/workpool/convex.config.js",
      });
      expect(parsed.failure.message).toContain("confect codegen");
      expect(parsed.failure.message).toContain("same release");
    },
  );

  it.each(invalidManifests)(
    "refuses a malformed manifest before reading mounted routes (%s)",
    (_, manifest) => {
      const component = Component.make("workpool", {
        manifest: manifest as typeof formatOne,
        client: (native: unknown) => native,
      });
      const routes = Declaration.routeLeaves(
        [],
        [
          Mount.data(
            Mount.make(component, { name: "pool", httpPrefix: "/pool" }),
          ),
        ],
      );
      expect(routes).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "UnsupportedManifestFormat" },
      });
    },
  );

  it("reads a mounted component's shipped manifest and refuses another format", () => {
    const shipped = {
      format: 1,
      sections: {},
      name: "workpool",
      env: {},
      mounts: {},
      http: {},
      digest: "sha256:child",
    } as const;
    const mountOf = (manifest: unknown) =>
      Mount.make(
        Component.make("workpool", {
          manifest: manifest as typeof shipped,
          client: (native: unknown) => native,
        }),
        { name: "pool" },
      );
    const app = (manifest: unknown) =>
      App.make({
        env: Env.make("tenant", {}),
        components: [workpool],
        mounts: [mountOf(manifest)],
      });
    const parsed = parseApp(app(shipped));
    assertIs(parsed, Result.isSuccess);
    expect(parsed.success.mounts[0]?.descriptor).toBe(shipped);
    for (const manifest of [{ ...shipped, format: 2 }, { format: 2 }]) {
      const refused = parseApp(app(manifest));
      assertIs(refused, Result.isFailure);
      expect(refused.failure).toMatchObject({
        _tag: "UnsupportedManifestFormat",
        source: "@convex-dev/workpool/convex.config.js",
      });
      expect(refused.failure.message).toContain("confect codegen");
    }
  });

  it.each(
    Array.flatMap(["app", "component"] as const, (target) =>
      Array.flatMap(["CONVEX_SITE_URL", "CONVEX_CLOUD_URL"] as const, (key) =>
        Array.map(["literal", "host-entry"] as const, (binding) => ({
          target,
          key,
          binding,
        })),
      ),
    ),
  )(
    "refuses $key with a $binding binding in a $target declaration",
    ({ target, key, binding }) => {
      const env = Env.make("host", { CUSTOM_URL: Env.string() });
      const evil = defineComponent("evil", { env: { [key]: v.string() } });
      // A descriptor from JavaScript or an older package can bypass make.
      const Evil = {
        name: "evil" as const,
        env: { [key]: Schema.String },
        client: (native: unknown) => native,
      };
      const bound =
        binding === "literal" ? "https://attacker.example" : env.CUSTOM_URL;
      const parsed = Declaration.parse({
        target,
        app: App.make({
          kind: target,
          env,
          components: [evil],
          mounts: [Mount.make(Evil, { name: "evil", env: { [key]: bound } })],
        }),
        auth: Option.none(),
        componentImport,
      });
      expect(parsed).toEqual(Result.fail(Env.ReservedEnvKey.make({ key })));
    },
  );

  it.each([
    [
      "app",
      App.make({
        env: Env.make("host", {}),
        components: [workpool],
        mounts: [Mount.make(Workpool, { name: "app" })],
      }),
    ],
    [
      "docs",
      App.make({
        env: Env.make("host", {}),
        components: [workpool],
        mounts: [Mount.make(Workpool, { name: "docs" })],
      }),
    ],
  ] as const)("refuses the inline literal mount name %s", (name, app) => {
    expect(parseApp(app)).toEqual(
      Result.fail(Declaration.ReservedMountName.make({ mount: name })),
    );
  });

  it("refuses reserved literals typed as Mount.Any or ReadonlyArray<Mount.Any>", () => {
    const app: Mount.Any = Mount.make(Workpool, { name: "app" });
    const docs: Mount.Any = Mount.make(Workpool, { name: "docs" });
    const mounts: ReadonlyArray<Mount.Any> = [
      Mount.make(Workpool, { name: "app" }),
      Mount.make(Workpool, { name: "docs" }),
    ];
    for (const mount of [app, docs, ...mounts]) {
      expect(
        parseApp(
          App.make({
            env: Env.make("host", {}),
            components: [workpool],
            mounts: [mount],
          }),
        ),
      ).toEqual(
        Result.fail(
          Declaration.ReservedMountName.make({ mount: Mount.data(mount).name }),
        ),
      );
    }
  });

  it.each(["app", "docs"])(
    "refuses the reserved child mount name %s inside a component",
    (name: string) => {
      expect(
        Declaration.parse({
          target: "component",
          app: App.make({
            kind: "component",
            env: Env.make("relay", {}),
            components: [workpool],
            mounts: [Mount.make(Workpool, { name })],
          }),
          auth: Option.none(),
          componentImport,
        }),
      ).toEqual(
        Result.fail(Declaration.ReservedMountName.make({ mount: name })),
      );
    },
  );

  it.each(["app", "docs"])(
    "refuses the reserved mount name %s after widening",
    (name: string) => {
      const parsed = parseApp(
        App.make({
          env: Env.make("host", {}),
          components: [workpool],
          mounts: [Mount.make(Workpool, { name })],
        }),
      );
      assertIs(parsed, Result.isFailure);
      expect(parsed.failure).toMatchObject({
        _tag: "ReservedMountName",
        mount: name,
        message: `The mount name "${name}" is reserved for the root app or docs page; choose another mount name.`,
      });
    },
  );

  it.each([
    "application",
    "docsWorker",
    "App",
    "Docs",
    "DOCS",
    "_worker",
    "worker2",
  ])("accepts the mount name %s", (name: string) => {
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [workpool],
        mounts: [Mount.make(Workpool, { name })],
      }),
    );
    assertIs(parsed, Result.isSuccess);
    expect(Array.map(parsed.success.mounts, (mount) => mount.name)).toEqual([
      name,
    ]);
  });

  it.each(
    Array.flatMap(["app", "component"] as const, (target) =>
      Array.flatMap(["app", "docs"] as const, (name) =>
        Array.map(["CONVEX_SITE_URL", "CONVEX_CLOUD_URL"] as const, (key) => ({
          target,
          name,
          key,
        })),
      ),
    ),
  )(
    "refuses mount $name before its $key binding in a $target declaration",
    ({ target, name, key }) => {
      const component = {
        name: "custom" as const,
        env: { [key]: Schema.String },
        client: (native: unknown) => native,
      };
      const parsed = Declaration.parse({
        target,
        app: App.make({
          kind: target,
          env: Env.make("host", {}),
          components: [
            defineComponent("custom", { env: { [key]: v.string() } }),
          ],
          mounts: [
            Mount.make(component, {
              name: name as string,
              env: { [key]: "custom" },
            }),
          ],
        }),
        auth: Option.none(),
        componentImport,
      });
      expect(parsed).toEqual(
        Result.fail(Declaration.ReservedMountName.make({ mount: name })),
      );
    },
  );

  it("rejects foreign, optional and secret provider env values", () => {
    const env = Env.make("tenant", {
      OPTIONAL: Env.optional(Env.string()),
      SECRET: Env.secret(),
    });
    const other = Env.make("platform", { ISSUER: Env.string() });
    const app = App.make({ env });
    for (const entry of [env.OPTIONAL, env.SECRET, other.ISSUER]) {
      const auth: unknown = {
        ...Auth.make(app, { providers: [] }),
        providers: [{ domain: entry, applicationID: "convex" }],
      };
      expect(
        Declaration.parse({
          target: "app",
          app,
          auth: Option.some(auth),
          componentImport,
        }),
      ).toEqual(
        Result.fail(
          Declaration.InvalidProviderEnv.make({
            field: "domain",
            key: Env.origin(entry).key,
            backend: "tenant",
          }),
        ),
      );
    }
  });

  it("promotes a child's open slot, keeps a bound one closed, and refuses a promoted name taken twice", () => {
    const child = {
      format: 1,
      sections: {},
      name: "ratelimiter",
      env: {
        LIMIT: { kind: "string", optional: false },
        TOKEN: { kind: "secret", optional: false },
      },
      mounts: {
        inner: {
          component: "inner",
          env: {
            KEY: { kind: "secret", optional: true, variable: "INNER_KEY" },
          },
        },
      },
      http: {},
      digest: "sha256:child",
    } as const;
    const Child = Component.make("ratelimiter", {
      manifest: child,
      client: (native: unknown) => native,
    });
    const env = Env.make("relay", { LIMITER_TOKEN: Env.secret() });
    const parsed = Declaration.parse({
      target: "component",
      app: App.make({
        kind: "component",
        env: Env.make("relay", {}),
        components: [ratelimiter],
        mounts: [Mount.make(Child, { name: "limiter", env: { LIMIT: "10" } })],
      }),
      auth: Option.none(),
      componentImport,
    });
    assertIs(parsed, Result.isSuccess);
    expect(parsed.success.promoted).toEqual([
      ["LIMITER_TOKEN", { kind: "secret", optional: false }],
      ["LIMITER_INNER_KEY", { kind: "secret", optional: true }],
    ]);
    expect(parsed.success.mounts[0]?.open).toEqual([
      ["TOKEN", { kind: "secret", optional: false, variable: "LIMITER_TOKEN" }],
      [
        "INNER_KEY",
        { kind: "secret", optional: true, variable: "LIMITER_INNER_KEY" },
      ],
    ]);
    const taken = Declaration.parse({
      target: "component",
      app: App.make({
        kind: "component",
        env,
        components: [ratelimiter],
        mounts: [Mount.make(Child, { name: "limiter", env: { LIMIT: "10" } })],
      }),
      auth: Option.none(),
      componentImport,
    });
    expect(taken).toEqual(
      Result.fail(
        Declaration.DerivedSlotCollision.make({
          variable: "LIMITER_TOKEN",
          first: "LIMITER_TOKEN",
          second: "limiter.TOKEN",
        }),
      ),
    );
  });

  it.each([
    ["bulkEmail", "BULK_EMAIL"],
    ["HTTPServer", "HTTP_SERVER"],
    ["myHTTPClient", "MY_HTTP_CLIENT"],
    ["s3Bucket", "S3_BUCKET"],
    ["x9Y", "X9_Y"],
    ["email2", "EMAIL2"],
    ["bulk_email", "BULK_EMAIL"],
  ])("derives deployment names from %s as %s", (mount, prefix) => {
    expect(Declaration.promotedName(mount, "KEY")).toBe(`${prefix}_KEY`);
  });

  it.each([
    {
      first: "bulkEmail",
      slot: "KEY",
      second: "bulk_email",
      variable: "BULK_EMAIL_KEY",
    },
    {
      first: "bulk",
      slot: "EMAIL_KEY",
      second: "bulkEmail",
      variable: "BULK_EMAIL_KEY",
    },
    {
      first: "HTTPServer",
      slot: "KEY",
      second: "http_server",
      variable: "HTTP_SERVER_KEY",
    },
  ])(
    "refuses the derived-name collision between $first and $second",
    ({ first, slot, second, variable }) => {
      const component = (key: string) =>
        Component.make("workpool", {
          env: { [key]: Schema.String },
          client: (native: unknown) => native,
        });
      const parsed = parseApp(
        App.make({
          env: Env.make("host", {}),
          components: [workpool],
          mounts: [
            Mount.make(component(slot), { name: first }),
            Mount.make(component("KEY"), { name: second }),
          ],
        }),
      );
      expect(parsed).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "DerivedSlotCollision",
          variable,
          first: `${first}.${slot}`,
          second: `${second}.KEY`,
        },
      });
    },
  );

  it("refuses a derived variable already declared by the host", () => {
    const component = Component.make("workpool", {
      env: { KEY: Schema.String },
      client: (native: unknown) => native,
    });
    const parsed = parseApp(
      App.make({
        env: Env.make("host", { POOL_KEY: Env.string() }),
        components: [workpool],
        mounts: [Mount.make(component, { name: "pool" })],
      }),
    );
    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "DerivedSlotCollision",
        variable: "POOL_KEY",
        first: "POOL_KEY",
        second: "pool.KEY",
      },
    });
  });

  it("refuses a collision between a nested slot and a sibling mount", () => {
    const relay = Component.make("workpool", {
      manifest: {
        ...formatOne,
        mounts: {
          inbox: {
            component: "inbox",
            env: {
              KEY: { kind: "string", optional: false, variable: "INBOX_KEY" },
            },
          },
        },
      },
      client: (native: unknown) => native,
    });
    const sibling = Component.make("workpool", {
      env: { KEY: Schema.String },
      client: (native: unknown) => native,
    });
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [workpool],
        mounts: [
          Mount.make(relay, { name: "relay" }),
          Mount.make(sibling, { name: "relayInbox" }),
        ],
      }),
    );
    expect(parsed).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "DerivedSlotCollision",
        variable: "RELAY_INBOX_KEY",
        first: "relay.INBOX_KEY",
        second: "relayInbox.KEY",
      },
    });
  });

  it("names the mount that derives an invalid deployment variable", () => {
    const component = Component.make("workpool", {
      env: { KEY: Schema.String },
      client: (native: unknown) => native,
    });
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [workpool],
        mounts: [Mount.make(component, { name: "_bulk" })],
      }),
    );
    assertIs(parsed, Result.isFailure);
    expect(parsed.failure).toMatchObject({
      _tag: "InvalidDerivedEnvKey",
      mount: "_bulk",
      slot: "KEY",
      variable: "_BULK_KEY",
    });
    expect(parsed.failure.message).toContain("_bulk");
  });

  it("preserves literal and secret slot kinds without a shipped manifest", () => {
    const component = Component.make("workpool", {
      env: {
        MODE: Schema.Literals(["live", "test"]),
        OPTIONAL_MODE: Schema.optionalKey(Schema.Literals(["log", "send"])),
        SINGLE: Schema.Literal("only"),
        TOKEN: Schema.Redacted(Schema.String),
        OPTIONAL_TOKEN: Schema.String.pipe(Schema.Redacted, Schema.optionalKey),
        FROM_VALUE: Schema.RedactedFromValue(Schema.String),
        NUMBER: Schema.Finite,
        MIXED: Schema.Union([Schema.String, Schema.Finite]),
      },
      client: (native: unknown) => native,
    });
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [workpool],
        mounts: [Mount.make(component, { name: "pool" })],
      }),
    );
    assertIs(parsed, Result.isSuccess);
    expect(parsed.success.promoted).toEqual([
      [
        "POOL_MODE",
        { kind: "literals", optional: false, values: ["live", "test"] },
      ],
      [
        "POOL_OPTIONAL_MODE",
        { kind: "literals", optional: true, values: ["log", "send"] },
      ],
      ["POOL_SINGLE", { kind: "literals", optional: false, values: ["only"] }],
      ["POOL_TOKEN", { kind: "secret", optional: false }],
      ["POOL_OPTIONAL_TOKEN", { kind: "secret", optional: true }],
      ["POOL_FROM_VALUE", { kind: "secret", optional: false }],
      ["POOL_NUMBER", { kind: "string", optional: false }],
      ["POOL_MIXED", { kind: "string", optional: false }],
    ]);
    const config = Declaration.convexConfig(parsed.success);
    expect(config).toContain(
      'POOL_MODE: v.union(v.literal("live"), v.literal("test")),',
    );
    expect(config).toContain("POOL_TOKEN: v.string(),");
  });

  it("splits camelCase mount names before promoting their open slots", () => {
    const Email = Component.make("workpool", {
      manifest: {
        format: 1,
        sections: {},
        name: "workpool",
        env: { RESEND_API_KEY: { kind: "secret", optional: false } },
        mounts: {},
        http: {},
        digest: "sha256:email",
      },
      client: (native: unknown) => native,
    });
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [workpool],
        mounts: [Mount.make(Email, { name: "bulkEmail" })],
      }),
    );
    assertIs(parsed, Result.isSuccess);
    expect(parsed.success.promoted).toEqual([
      ["BULK_EMAIL_RESEND_API_KEY", { kind: "secret", optional: false }],
    ]);
    expect(Declaration.convexConfig(parsed.success)).toContain(
      "RESEND_API_KEY: app.env.BULK_EMAIL_RESEND_API_KEY,",
    );
    expect(Declaration.promotedName("bulkEmail", "CHILD_RESEND_API_KEY")).toBe(
      "BULK_EMAIL_CHILD_RESEND_API_KEY",
    );
  });

  it("refuses a collision caused by splitting a camelCase mount name", () => {
    const app = App.make({
      env: Env.make("host", {}),
      components: [ratelimiter],
      mounts: [
        Mount.make(Ratelimiter, { name: "aB" }),
        Mount.make(Ratelimiter, { name: "a_b" }),
      ],
    });
    expect(parseApp(app)).toEqual(
      Result.fail(
        Declaration.DerivedSlotCollision.make({
          variable: "A_B_LIMIT",
          first: "aB.LIMIT",
          second: "a_b.LIMIT",
        }),
      ),
    );
  });

  it.each([
    ["GET", "/other"],
    ["POST", "/ready"],
    ["GET", "/ready"],
  ])("refuses duplicate route identities even for %s %s", (method, path) => {
    const first = {
      method: "GET",
      path: "/ready",
      owner: "app",
      group: "meta",
      endpoint: "ready",
    };
    const catalogue = Declaration.routeCatalogue(
      [first, { ...first, method, path }],
      "sha256:host",
    );
    expect(catalogue).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "DuplicateRouteIdentity",
        owner: "app",
        group: "meta",
        endpoint: "ready",
        first: { method: "GET", path: "/ready" },
        second: { method, path },
      },
    });
  });

  it("gives equally named nested mounts distinct owners under their parents", () => {
    const route = {
      method: "POST",
      path: "/child/received",
      owner: "child",
      group: "hooks",
      endpoint: "received",
      digest: "sha256:child",
    };
    const component = Component.make("workpool", {
      manifest: {
        ...formatOne,
        http: { child: { hooks: { received: route } } },
      },
      client: (native: unknown) => native,
    });
    const leaves = Declaration.routeLeaves(
      [],
      Array.map(["first", "second"], (name) =>
        Mount.data(Mount.make(component, { name, httpPrefix: `/${name}` })),
      ),
    );
    assertIs(leaves, Result.isSuccess);
    expect(Array.map(leaves.success, ({ owner }) => owner)).toEqual([
      "first/child",
      "second/child",
    ]);
    const catalogue = Declaration.routeCatalogue(leaves.success, "sha256:host");
    expect(catalogue).toMatchObject({
      _tag: "Success",
      success: {
        "first/child": {
          hooks: { received: { path: "/first/child/received" } },
        },
        "second/child": {
          hooks: { received: { path: "/second/child/received" } },
        },
      },
    });
  });

  it("keeps an owner named constructor without changing inherited objects", () => {
    const leaf = {
      method: "GET",
      path: "/ready",
      owner: "constructor",
      group: "catalogueFixture",
      endpoint: "ready",
    };
    const before = Object.getOwnPropertyDescriptor(Object, "catalogueFixture");
    try {
      const catalogue = Declaration.routeCatalogue([leaf], "sha256:host");
      assertIs(catalogue, Result.isSuccess);
      expect(Declaration.previousLeaves(catalogue.success)).toEqual([leaf]);
      expect(
        Object.getOwnPropertyDescriptor(Object, "catalogueFixture"),
      ).toEqual(before);
    } finally {
      if (before === undefined)
        Reflect.deleteProperty(Object, "catalogueFixture");
      else Object.defineProperty(Object, "catalogueFixture", before);
    }
  });

  it("places a mounted component's routes under its prefix and name, nested owners included", () => {
    const leaf = (owner: string, path: string) => ({
      method: "POST",
      path,
      owner,
      group: "hooks",
      endpoint: "received",
      digest: "sha256:child",
    });
    const relay = Component.make("relay", {
      manifest: {
        format: 1,
        sections: {},
        name: "relay",
        env: {},
        mounts: {},
        http: {
          app: { hooks: { received: leaf("app", "/received") } },
          child: { hooks: { received: leaf("child", "/child/received") } },
        },
        digest: "sha256:child",
      },
      client: (native: unknown) => native,
    });
    const leaves = Declaration.routeLeaves(
      [
        {
          method: "GET",
          path: "/status",
          owner: { kind: "app" },
          group: "meta",
          endpoint: "status",
        },
        { method: "GET", path: "/docs", owner: { kind: "docs" } },
      ],
      [
        Mount.data(Mount.make(relay, { name: "relay", httpPrefix: "/relay/" })),
        Mount.data(Mount.make(relay, { name: "hidden" })),
      ],
    );
    assertIs(leaves, Result.isSuccess);
    expect(leaves.success).toEqual([
      {
        method: "GET",
        path: "/status",
        owner: "app",
        group: "meta",
        endpoint: "status",
      },
      {
        method: "POST",
        path: "/relay/received",
        owner: "relay",
        group: "hooks",
        endpoint: "received",
      },
      {
        method: "POST",
        path: "/relay/child/received",
        owner: "relay/child",
        group: "hooks",
        endpoint: "received",
      },
    ]);
    const catalogue = Declaration.routeCatalogue(leaves.success, "sha256:host");
    assertIs(catalogue, Result.isSuccess);
    expect(catalogue.success["relay/child"]?.hooks?.received?.digest).toBe(
      "sha256:host",
    );
    expect(Declaration.previousLeaves(catalogue.success)).toEqual(
      leaves.success,
    );
  });

  it("refuses env on a root app's mount when types were bypassed", () => {
    const app: unknown = {
      ...App.make({ env: Env.make("host", {}), components: [ratelimiter] }),
      mounts: [
        Mount.make(Ratelimiter, { name: "limiter", env: { LIMIT: "10" } }),
      ],
    };
    expect(parseApp(app)).toEqual(
      Result.fail(
        Declaration.RootMountEnv.make({ mount: "limiter", slots: ["LIMIT"] }),
      ),
    );
  });

  it("renders a Confect-authored component's own definition", () => {
    const env = Env.make("email", {
      FROM: Env.string(),
      TRANSPORT: Env.literals(["resend"]),
    });
    const parsed = Declaration.parse({
      target: "component",
      app: App.make({
        kind: "component",
        env,
        components: [ratelimiter],
        mounts: [
          Mount.make(Ratelimiter, { name: "limiter", env: { LIMIT: "10" } }),
        ],
      }),
      auth: Option.none(),
      componentImport,
    });
    assertIs(parsed, Result.isSuccess);
    expect(Declaration.convexConfig(parsed.success)).toBe(
      `// Generated by \`confect codegen\` from confect/app.ts. Do not edit.
import { defineComponent } from "convex/server";
import { v } from "convex/values";
import ratelimiter from "@convex-dev/ratelimiter/convex.config.js";

const component = defineComponent("email", {
  env: {
    FROM: v.string(),
    TRANSPORT: v.literal("resend"),
  },
});

component.use(ratelimiter, {
  name: "limiter",
  env: {
    LIMIT: "10",
  },
});

export default component;
`,
    );
  });

  it("never uses a reserved word as an import name", () => {
    const Worker = Component.make("default", {
      client: (native: unknown) => native,
    });
    const parsed = Declaration.parse({
      target: "app",
      app: App.make({
        env: Env.make("host", {}),
        components: [defineComponent("default")],
        mounts: [Mount.make(Worker, { name: "worker" })],
      }),
      auth: Option.none(),
      componentImport: () =>
        Option.some({
          importPath: "./worker/convex.config",
          componentName: "default",
        }),
    });
    assertIs(parsed, Result.isSuccess);
    const config = Declaration.convexConfig(parsed.success);
    expect(config).toContain(
      'import defaultComponent from "./worker/convex.config";',
    );
    expect(config).toContain("app.use(defaultComponent, {");
  });

  it("writes app.use for each mount in list order, importing each definition once", () => {
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [workpool, ratelimiter],
        mounts: [
          Limiter,
          Mount.make(Workpool, { name: "importsPool", httpPrefix: "/imports" }),
          Mount.make(Workpool, { name: "exportsPool" }),
        ],
      }),
    );
    assertIs(parsed, Result.isSuccess);
    expect(Declaration.convexConfig(parsed.success)).toBe(
      `// Generated by \`confect codegen\` from confect/app.ts. Do not edit.
import { defineApp } from "convex/server";
import { v } from "convex/values";
import ratelimiter from "@convex-dev/ratelimiter/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp({
  env: {
    LIMITER_LIMIT: v.string(),
  },
});

app.use(ratelimiter, {
  name: "limiter",
  env: {
    LIMIT: app.env.LIMITER_LIMIT,
  },
});

app.use(workpool, {
  name: "importsPool",
  httpPrefix: "/imports",
});

app.use(workpool, {
  name: "exportsPool",
});

export default app;
`,
    );
  });

  it("refuses a mount whose component has no listed definition", () => {
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [ratelimiter],
        mounts: [Limiter, Mount.make(Workpool, { name: "importsPool" })],
      }),
    );
    assertIs(parsed, Result.isFailure);
    expect(parsed.failure.message).toBe(
      'The mount "importsPool" mounts the component "workpool", but App.make\'s components lists no definition named "workpool".',
    );
  });

  it("refuses a listed definition that no mount mounts", () => {
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [ratelimiter, workpool],
        mounts: [Limiter],
      }),
    );
    assertIs(parsed, Result.isFailure);
    expect(parsed.failure.message).toBe(
      'App.make\'s components lists the definition "workpool" from @convex-dev/workpool/convex.config.js, but no mount mounts it.',
    );
  });

  it("refuses two mounts with one name", () => {
    const parsed = parseApp(
      App.make({
        env: Env.make("host", {}),
        components: [ratelimiter, workpool],
        mounts: [Limiter, Mount.make(Workpool, { name: "limiter" })],
      }),
    );
    assertIs(parsed, Result.isFailure);
    expect(parsed.failure.message).toBe(
      'Two mounts are named "limiter", one of "ratelimiter" and one of "workpool"; give each mount its own name.',
    );
  });

  it("refuses distinct definitions sharing one defineComponent name", () => {
    const first = defineComponent("workpool");
    const second = defineComponent("workpool");
    const Pool = Component.make("workpool", {
      client: (native: unknown) => native,
    });
    const parsed = Declaration.parse({
      target: "app",
      app: App.make({
        env: Env.make("host", {}),
        components: [first, second],
        mounts: [Mount.make(Pool, { name: "importsPool" })],
      }),
      auth: Option.none(),
      componentImport: (definition) =>
        Option.some({
          importPath:
            definition === first
              ? "@one/pool/convex.config.js"
              : "@two/pool/convex.config.js",
          componentName: "workpool",
        }),
    });
    assertIs(parsed, Result.isFailure);
    expect(parsed.failure.message).toBe(
      'Two component definitions are named "workpool", from @one/pool/convex.config.js and @two/pool/convex.config.js; give each definition its own name.',
    );
  });

  it("rejects an entry from another backend's env when types were bypassed", () => {
    const env = Env.make("tenant", {});
    const other = Env.make("platform", { LIMIT: Env.string() });
    const app: unknown = {
      ...App.make({ env, components: [ratelimiter] }),
      mounts: [
        Mount.make(Ratelimiter, {
          name: "limiter",
          env: { LIMIT: other.LIMIT },
        }),
      ],
    };
    expect(parseApp(app)).toEqual(
      Result.fail(
        Declaration.ForeignEnvBinding.make({
          mount: "limiter",
          slot: "LIMIT",
          backend: "platform",
          key: "LIMIT",
          expectedBackend: "tenant",
        }),
      ),
    );
  });

  it("rejects a binding that is neither a constant nor an env entry", () => {
    const app: unknown = {
      ...App.make({ env: Env.make("tenant", {}), components: [ratelimiter] }),
      mounts: [
        Mount.make(Ratelimiter, {
          name: "limiter",
          env: { LIMIT: 1 as unknown as string },
        }),
      ],
    };
    expect(parseApp(app)).toEqual(
      Result.fail(
        Declaration.InvalidBinding.make({ mount: "limiter", slot: "LIMIT" }),
      ),
    );
  });

  it.each(["app", "component"] as const)(
    "refuses reserved env slots in an untyped %s declaration",
    (target) => {
      const entry = Env.make("host", { CUSTOM_URL: Env.string() }).CUSTOM_URL;
      for (const key of ["CONVEX_SITE_URL", "CONVEX_CLOUD_URL"]) {
        const env: Env.Any = {
          "~@confect/core/Env": { name: "host", entries: [[key, entry]] },
        };
        const parsed = Declaration.parse({
          target,
          app: App.make({ kind: target, env }),
          auth: Option.none(),
          componentImport,
        });
        assertIs(parsed, Result.isFailure);
        expect(parsed.failure).toMatchObject({
          _tag: "ReservedEnvKey",
          key,
          message: `The env slot "${key}" is reserved for a Convex built-in address; read it without declaring a slot.`,
        });
      }
    },
  );

  it.each([
    "CONVEX_CUSTOM_URL",
    "CONVEX_SITE_URL_SUFFIX",
    "CONVEX_SITE_URL_2",
    "MY_CONVEX_SITE_URL",
    "SITE_URL",
    "CONVEX_URL",
    "convex_site_url",
  ])("accepts the declared env slot %s", (key: string) => {
    const parsed = parseApp(
      App.make({ env: Env.make("host", { [key]: Env.string() }) }),
    );
    assertIs(parsed, Result.isSuccess);
    expect(Array.map(parsed.success.env, ([name]) => name)).toEqual([key]);
  });

  it.each([
    "CONVEX_SITE_URL_2",
    "MY_CONVEX_SITE_URL",
    "SITE_URL",
    "CONVEX_URL",
    "convex_site_url",
  ])("accepts the mount env slot %s", (key: string) => {
    const component = Component.make("custom", {
      env: { [key]: Schema.String },
      client: (native: unknown) => native,
    });
    const parsed = Declaration.parse({
      target: "component",
      auth: Option.none(),
      componentImport,
      app: App.make({
        kind: "component",
        env: Env.make("host", {}),
        components: [defineComponent("custom", { env: { [key]: v.string() } })],
        mounts: [
          Mount.make(component, { name: "custom", env: { [key]: "ok" } }),
        ],
      }),
    });
    assertIs(parsed, Result.isSuccess);
    expect(parsed.success.mounts[0]?.env).toEqual([
      [key, { kind: "value", value: "ok" }],
    ]);
  });

  it("owns only files with its header or a file an earlier codegen wrote", () => {
    const legacy =
      'import auth from "../confect/auth";\n\nexport default auth;\n';
    expect(
      Declaration.isGenerated(
        `${Declaration.header("confect/app.ts")}\nexport default 1;\n`,
        [],
      ),
    ).toBe(true);
    expect(Declaration.isGenerated(legacy, [legacy])).toBe(true);
    expect(
      Declaration.isGenerated('import { defineApp } from "convex/server";\n', [
        legacy,
      ]),
    ).toBe(false);
  });

  it("hashes every semantic manifest field and ignores its own digest fields", () => {
    const original = {
      files: [] as ReadonlyArray<readonly [string, string]>,
      versions: [],
      manifest: formatOne,
    };
    const changed = {
      ...original,
      manifest: {
        ...formatOne,
        env: { KEY: { kind: "string", optional: false } },
      },
    };
    expect(Declaration.digest(changed)).not.toBe(Declaration.digest(original));
    const differentDigest = {
      ...original,
      manifest: { ...formatOne, digest: "sha256:other" },
    };
    expect(Declaration.digest(differentDigest)).toBe(
      Declaration.digest(original),
    );
  });

  it("omits route digests but includes a section field named digest", () => {
    const leaf = {
      method: "GET",
      path: "/ready",
      owner: "app",
      group: "health",
      endpoint: "ready",
      digest: "sha256:first",
    };
    const original = {
      files: [],
      versions: [],
      manifest: {
        ...formatOne,
        http: { app: { health: { ready: leaf } } },
        sections: { custom: { digest: "meaningful" } },
      },
    };
    const routeDigest = {
      ...original,
      manifest: {
        ...original.manifest,
        http: {
          app: { health: { ready: { ...leaf, digest: "sha256:second" } } },
        },
      },
    };
    const sectionDigest = {
      ...original,
      manifest: {
        ...original.manifest,
        sections: { custom: { digest: "changed" } },
      },
    };
    expect(Declaration.digest(routeDigest)).toBe(Declaration.digest(original));
    expect(Declaration.digest(sectionDigest)).not.toBe(
      Declaration.digest(original),
    );
  });

  it("canonicalises object keys before hashing manifest and section data", () => {
    const original = {
      files: [],
      versions: [],
      sections: { tags: { format: 1, functions: { a: "one", b: "two" } } },
      manifest: formatOne,
    };
    const reordered = {
      ...original,
      sections: { tags: { functions: { b: "two", a: "one" }, format: 1 } },
      manifest: {
        digest: formatOne.digest,
        http: {},
        mounts: {},
        env: {},
        name: formatOne.name,
        format: 1 as const,
        sections: {},
      },
    };
    expect(Declaration.digest(reordered)).toBe(Declaration.digest(original));
  });

  it("normalises CRLF source inputs and includes the CLI release", () => {
    const original = {
      files: [["confect/app.ts", "first\nsecond\n"]] as const,
      versions: [["@confect/cli", "10.6.0"]] as const,
    };
    expect(
      Declaration.digest({
        ...original,
        files: [["confect/app.ts", "first\r\nsecond\r\n"]],
      }),
    ).toBe(Declaration.digest(original));
    expect(
      Declaration.digest({
        ...original,
        versions: [["@confect/cli", "11.0.0"]],
      }),
    ).not.toBe(Declaration.digest(original));
  });

  it("digests the same inputs identically in any order", () => {
    const files = [
      ["confect/app.ts", "a"],
      ["confect/env.ts", "e"],
    ] as const;
    const versions = [["convex", "1.46.0"]] as const;
    const digest = Declaration.digest({ files, versions });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Declaration.digest({ files: Array.reverse(files), versions })).toBe(
      digest,
    );
    expect(
      Declaration.digest({ files, versions: [["convex", "1.47.0"]] }),
    ).not.toBe(digest);
  });
});

describe("Declaration errors", () => {
  it.each([
    [
      Declaration.InvalidEnvKey.make({ key: "1BAD" }),
      'InvalidEnvKey: "1BAD" is not a valid Convex environment variable name; use letters, digits and underscores, starting with a letter.',
    ],
    [
      Declaration.ForeignEnvBinding.make({
        mount: "limiter",
        slot: "LIMIT",
        backend: "other",
        key: "RATE",
        expectedBackend: "app",
      }),
      'ForeignEnvBinding: The mount "limiter" binds LIMIT to RATE of the "other" env, but this backend\'s env is "app".',
    ],
    [
      Declaration.InvalidBinding.make({ mount: "limiter", slot: "LIMIT" }),
      'InvalidBinding: The mount "limiter" binds LIMIT to something other than a string or an entry of this backend\'s env.',
    ],
    [
      Declaration.InvalidComponentDefinition.make({ index: 2 }),
      "InvalidComponentDefinition: App.make's components[2] must be the default export of a component's convex.config module, imported directly in the declaration.",
    ],
    [
      Declaration.AuthForAnotherBackend.make({
        backend: "other",
        expectedBackend: "app",
      }),
      'AuthForAnotherBackend: confect/auth.ts declares auth for the "other" backend, but confect/app.ts declares "app".',
    ],
    [
      Declaration.InvalidProviderEnv.make({
        field: "domain",
        key: "SECRET",
        backend: "app",
      }),
      'InvalidProviderEnv: Auth provider field "domain" requires a non-secret, required string entry of the "app" env; got "SECRET".',
    ],
  ])("prints %s", (error, printed) => {
    expect(String(error)).toBe(printed);
  });
});
