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

describe("Declaration", () => {
  it("reads a mounted component's shipped manifest and refuses another format", () => {
    const shipped = {
      format: 1,
      name: "workpool",
      env: {},
      mounts: {},
      http: { mounts: {} },
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
    expect(parseApp(app({ ...shipped, format: 2 }))).toEqual(
      Result.fail(
        Declaration.UnsupportedDescriptorFormat.make({
          mount: "pool",
          format: 2,
        }),
      ),
    );
    expect(parseApp(app({ format: 2 }))).toEqual(
      Result.fail(
        Declaration.UnsupportedDescriptorFormat.make({
          mount: "pool",
          format: 2,
        }),
      ),
    );
  });

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
      http: { mounts: {} },
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

  it("splits camelCase mount names before promoting their open slots", () => {
    const Email = Component.make("workpool", {
      manifest: {
        format: 1,
        name: "workpool",
        env: { RESEND_API_KEY: { kind: "secret", optional: false } },
        mounts: {},
        http: { mounts: {} },
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
