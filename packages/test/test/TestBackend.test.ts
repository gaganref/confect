import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as MutationCtx from "@confect/server/MutationCtx";
import * as PushCheck from "@confect/server/PushCheck";
import { TestBackend, TestConfect } from "@confect/test";
import { Env, FunctionSpec, GroupSpec, Ref } from "@confect/core";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  componentsGeneric,
  cronJobs,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { assertIs } from "./internal/assertIs";
import { diedWith } from "./internal/diedWith";
import { pushChecked, pushCheckRefusal } from "./fixtures/pushChecked";
import { openSession } from "../src/internal/Backend";
import { diagnosticsOf } from "./fixtures/WidenedManifest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fileURLToPath } from "node:url";

declare const process: { env: Record<string, string | undefined> };

type Query<R> = FunctionReference<"query", "internal", {}, R>;
type Mutation<A extends Record<string, string>> = FunctionReference<
  "mutation",
  "internal",
  A,
  null
>;

interface StateApi {
  readonly log: Query<Array<string>>;
  readonly env: Query<string>;
  readonly boot: Query<string>;
  readonly view: Query<string>;
  readonly put: Mutation<{ entry: string }>;
  readonly leak: Mutation<{}>;
}

const components = componentsGeneric() as unknown as {
  readonly parent: {
    readonly state: StateApi & {
      readonly childLog: Query<Array<string>>;
      readonly childEnv: Query<string>;
      readonly putChild: Mutation<{ entry: string }>;
      readonly leakChild: Mutation<{}>;
    };
  };
  readonly child: { readonly state: StateApi };
};

const steps = (
  list: ReadonlyArray<{ path: string; nested: boolean; label: string | null }>,
) =>
  internalMutationGeneric({
    args: {},
    handler: () =>
      Promise.resolve(
        Arr.map(list, ({ path, nested, label }) => ({
          componentPath: path,
          nested,
          init:
            label === null
              ? null
              : { functionName: "init:run", args: { label } },
        })),
      ),
  });

const logSchema = defineSchema({ log: defineTable({ entry: v.string() }) });

/**
 * A component whose `init` records its label and what its child had logged by
 * then, and whose functions read its environment and its child's.
 */
const component = (child: boolean) => ({
  "_generated/server.ts": () => Promise.resolve({}),
  ...(child
    ? {
        "confectDeploy.ts": () =>
          Promise.resolve({
            steps: steps([{ path: "child", nested: false, label: "child" }]),
          }),
      }
    : {
        "crons.ts": () => {
          const crons = cronJobs();
          crons.interval(
            "beat",
            { minutes: 1 },
            makeFunctionReference<"mutation">("state:tick"),
          );
          return Promise.resolve({ default: crons });
        },
      }),
  "init.ts": () =>
    Promise.resolve({
      run: internalMutationGeneric({
        args: { label: v.string() },
        handler: (ctx, { label }) =>
          (child
            ? ctx.runQuery(components.child.state.log, {})
            : Promise.resolve<Array<string>>([])
          ).then((below) =>
            ctx.db
              .insert("log", {
                entry: `${label} saw [${Arr.join(below, ",")}]`,
              })
              .then(() => null),
          ),
      }),
    }),
  "state.ts": () => {
    // Module code runs as the component's modules load, before any function.
    const booted = process.env["REQUIRED"] ?? "missing";
    return Promise.resolve({
      boot: queryGeneric({ args: {}, handler: () => Promise.resolve(booted) }),
      view: queryGeneric({
        args: {},
        handler: () => {
          const spread = { ...process.env };
          return Promise.resolve(
            Arr.join(
              [
                `spread=${Arr.join(Rec.keys(spread).sort(), ",")}`,
                `keys=${Arr.join(Rec.keys(process.env).sort(), ",")}`,
                `in=${"REQUIRED" in process.env}`,
                `host=${"FIXTURE_ORIGIN" in process.env}`,
              ],
              " ",
            ),
          );
        },
      }),
      log: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("log")
            .collect()
            .then((rows) => Arr.map(rows, ({ entry }) => entry)),
      }),
      env: queryGeneric({
        args: {},
        handler: () =>
          Promise.resolve(
            `${process.env["REQUIRED"] ?? "missing"}|${process.env["KEY"] ?? "missing"}`,
          ),
      }),
      put: mutationGeneric({
        args: { entry: v.string() },
        handler: (ctx, { entry }) =>
          ctx.db.insert("log", { entry }).then(() => null),
      }),
      leak: mutationGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("log")
            .first()
            .then((row) => {
              throw new Error(`the stored entry is ${row?.entry}`);
            }),
      }),
      tick: mutationGeneric({ args: {}, handler: () => Promise.resolve(null) }),
      ...(child
        ? {
            childLog: queryGeneric({
              args: {},
              handler: (ctx): Promise<Array<string>> =>
                ctx.runQuery(components.child.state.log, {}),
            }),
            childEnv: queryGeneric({
              args: {},
              handler: (ctx): Promise<string> =>
                ctx.runQuery(components.child.state.env, {}),
            }),
            putChild: mutationGeneric({
              args: { entry: v.string() },
              handler: (ctx, args) =>
                ctx.runMutation(components.child.state.put, args),
            }),
            leakChild: mutationGeneric({
              args: {},
              handler: (ctx) =>
                ctx.runMutation(components.child.state.leak, {}),
            }),
          }
        : {}),
    });
  },
});

const host = DatabaseSchema.make({});
const hostSchema = defineSchema({ seen: defineTable({ entry: v.string() }) });

const childSecrets: TestConfect.SecretPolicy = {
  tables: {
    "": {
      log: () =>
        Schema.Struct({ entry: Schema.RedactedFromValue(Schema.String) }),
    },
  },
};

/**
 * The app's registry. `prefix` writes its module keys as a glob from another
 * directory would, and `deploy: false` leaves out the app's deploy module.
 */
const appOf = ({
  prefix = "",
  deploy = true,
  secrets = false,
}: {
  readonly prefix?: string;
  readonly deploy?: boolean;
  readonly secrets?: boolean;
} = {}): TestConfect.DeclaredApp<typeof host> => ({
  schema: host,
  convexSchema: hostSchema as never,
  httpMounts: [],
  modules: {
    [`${prefix}_generated/server.ts`]: () => Promise.resolve({}),
    ...(deploy
      ? {
          [`${prefix}confectDeploy.ts`]: () =>
            Promise.resolve({
              steps: steps([{ path: "parent", nested: true, label: "parent" }]),
            }),
        }
      : {}),
  },
  components: {
    parent: { schema: logSchema, modules: component(true) },
    "parent/child": {
      register: (t, name) =>
        t.registerComponent(name, logSchema, component(false), {
          standing: ["state:tick"],
          ...(secrets ? { secrets: childSecrets } : {}),
        }),
    },
  },
});

const settings = [
  { name: "FIXTURE_ORIGIN", owner: "fixture", optional: false },
  { name: "FIXTURE_LEVEL", owner: "fixture", optional: true },
] as const;

const unbound: ReadonlyArray<TestBackend.Mount> = [
  { path: "parent", kit: "local", env: {}, required: [] },
  { path: "parent/child", kit: "fixture-kit", env: {}, required: [] },
];

const backendOf = (
  app: TestConfect.DeclaredApp<typeof host> = appOf(),
  mounts: ReadonlyArray<TestBackend.Mount> = unbound,
) =>
  TestBackend.make(app, {
    refs: {},
    groups: {},
    ports: {},
    laws: [],
    obligations: [],
    manifestDigest: "sha256:fixture",
    mounts,
    settings,
  });

const backend = backendOf();

const config = { FIXTURE_ORIGIN: "https://fixture.test" };

/**
 * What the seed saw: the parent's log, then its child's.
 */
const seed = Effect.gen(function* () {
  const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
  const parent = yield* Effect.promise(() =>
    ctx.runQuery(components.parent.state.log, {}),
  );
  const child = yield* Effect.promise(() =>
    ctx.runQuery(components.parent.state.childLog, {}),
  );
  yield* Effect.promise(() =>
    ctx.db.insert("seen", {
      entry: `parent [${Arr.join(parent, ",")}] child [${Arr.join(child, ",")}]`,
    }),
  );
});

const seen = (test: TestConfect.TestConfect<typeof host>) =>
  test.run(
    Effect.gen(function* () {
      const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
      const rows = yield* Effect.promise(() => ctx.db.query("seen").collect());
      return pipe(
        rows,
        Arr.map((row) => row["entry"] as string),
        Arr.join("\n"),
      );
    }),
    Schema.String,
  );

const query = <R>(
  test: TestConfect.TestConfect<typeof host>,
  reference: Query<R>,
) =>
  test.run(
    Effect.gen(function* () {
      const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
      const answer = yield* Effect.promise(() => ctx.runQuery(reference, {}));
      return String(answer);
    }),
    Schema.String,
  );

/**
 * Run `body` with the services `layer` builds, in the test's scope.
 */
const within = <A, E, R, ROut, LE>(
  layer: Layer.Layer<ROut, LE>,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layer);
    return yield* body.pipe(Effect.provideContext(services));
  });

describe("TestBackend.layer", () => {
  it.effect(
    "runs each mount's init as a push does, a parent's before its child's, then the seed in one mutation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof host>();
        const session = yield* TestBackend.Session;
        expect(session.initialized).toEqual(["parent", "parent/child"]);
        // The parent's init ran before its child's, so it saw an empty log.
        const saw = yield* seen(test);
        expect(saw).toBe("parent [parent saw []] child [child saw []]");
      }).pipe((body) => within(backend.layer({ config, seed }), body)),
  );

  it.effect("finds the app's deploy module under glob-style module keys", () =>
    Effect.gen(function* () {
      const session = yield* TestBackend.Session;
      expect(session.initialized).toEqual(["parent", "parent/child"]);
    }).pipe((body) =>
      within(backendOf(appOf({ prefix: "./" })).layer({ config }), body),
    ),
  );

  it.effect("loads every module when no init or seed calls the kernel", () =>
    Effect.gen(function* () {
      const session = yield* TestBackend.Session;
      expect(session.initialized).toEqual([]);
      expect(session.crons).toEqual([
        { componentPath: "parent/child", name: "beat", udfPath: "state:tick" },
      ]);
    }).pipe((body) =>
      within(backendOf(appOf({ deploy: false })).layer({ config }), body),
    ),
  );

  it.effect(
    "gives each mount the settings it binds, literal or forwarded from the backend that mounts it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof host>();
        const parent = yield* query(test, components.parent.state.env);
        expect(parent).toBe("first-required|https://fixture.test");
        const child = yield* query(test, components.parent.state.childEnv);
        expect(child).toBe("https://fixture.test|missing");
        // A component's environment never reaches the app.
        expect(process.env["REQUIRED"]).toBeUndefined();
      }).pipe((body) =>
        within(
          backendOf(appOf(), [
            {
              path: "parent",
              kit: "local",
              env: {
                REQUIRED: { value: "first-required" },
                KEY: { from: "FIXTURE_ORIGIN" },
              },
              required: ["REQUIRED"],
            },
            {
              path: "parent/child",
              kit: "fixture-kit",
              env: { REQUIRED: { from: "KEY" } },
              required: ["REQUIRED"],
            },
          ]).layer({ config }),
          body,
        ),
      ),
  );

  it.effect(
    "binds a mount's settings while its modules load, as a deployment does",
    () =>
      Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof host>();
        const booted = yield* query(test, components.parent.state.boot);
        expect(booted).toBe("component-value");
        const read = yield* query(test, components.parent.state.env);
        expect(read).toBe("component-value|missing");
      }).pipe((body) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            process.env["REQUIRED"] = "app-value";
          }),
          () =>
            within(
              backendOf(appOf(), [
                {
                  path: "parent",
                  kit: "local",
                  env: { REQUIRED: { value: "component-value" } },
                  required: ["REQUIRED"],
                },
                unbound[1]!,
              ]).layer({ config }),
              body,
            ),
          () =>
            Effect.sync(() => {
              delete process.env["REQUIRED"];
            }),
        ),
      ),
  );

  it.effect(
    "enumerates a component's settings as a plain object of them, mount-only ones included",
    () =>
      Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof host>();
        const view = yield* query(test, components.parent.state.view);
        expect(view).toBe(
          "spread=CONVEX_CLOUD_URL,CONVEX_SITE_URL,KEY,REQUIRED keys=CONVEX_CLOUD_URL,CONVEX_SITE_URL,KEY,REQUIRED in=true host=false",
        );
      }).pipe((body) =>
        within(
          backendOf(appOf(), [
            {
              path: "parent",
              kit: "local",
              env: {
                REQUIRED: { value: "mount-only" },
                KEY: { from: "FIXTURE_ORIGIN" },
              },
              required: ["REQUIRED"],
            },
            unbound[1]!,
          ]).layer({ config }),
          body,
        ),
      ),
  );

  it.effect(
    "refuses to open without a mount's required setting, naming the mount",
    () =>
      Effect.gen(function* () {
        const error = yield* Layer.build(
          backendOf(appOf(), [
            unbound[0]!,
            {
              path: "parent/child",
              kit: "fixture-kit",
              env: { REQUIRED: { from: "UNBOUND" } },
              required: ["REQUIRED"],
            },
          ]).layer({ config }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "TestConfigMissing",
          setting: "REQUIRED",
          owner: "the mount parent/child",
        });
      }),
  );

  it.effect(
    "keys a kit's secret policy at the path it registers, so a packaged component's secret stays marked",
    () =>
      Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof host>();
        const canary = "canary-kit-8b1e04f7";
        const ctx = MutationCtx.MutationCtx<GenericDataModel>();
        yield* test.run(
          Effect.flatMap(ctx, (raw) =>
            Effect.promise(() =>
              raw.runMutation(components.parent.state.putChild, {
                entry: canary,
              }),
            ),
          ),
        );
        const exit = yield* Effect.exit(
          test.run(
            Effect.flatMap(ctx, (raw) =>
              Effect.promise(() =>
                raw.runMutation(components.parent.state.leakChild, {}),
              ),
            ),
          ),
        );
        assertIs(exit, Exit.isFailure);
        const report = Cause.pretty(exit.cause);
        expect(report).toContain("[redacted]");
        expect(report).not.toContain(canary);
      }).pipe((body) =>
        within(
          backendOf(appOf({ deploy: false, secrets: true })).layer({ config }),
          body,
        ),
      ),
  );

  it.effect("records each kit's standing sources as it registered them", () =>
    Effect.gen(function* () {
      const session = yield* TestBackend.Session;
      expect(session.standing).toEqual({
        parent: [],
        "parent/child": ["state:tick"],
      });
      expect(session.crons).toEqual([
        { componentPath: "parent/child", name: "beat", udfPath: "state:tick" },
      ]);
    }).pipe((body) => within(backend.layer({ config }), body)),
  );

  it.effect(
    "refuses to open without a required setting, naming its owner and docs",
    () =>
      Effect.gen(function* () {
        const error = yield* Layer.build(
          backend.layer({ config: {} as typeof config }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "TestConfigMissing",
          setting: "FIXTURE_ORIGIN",
          owner: "fixture",
          docs: "https://confect.dev/guides/testing#configuration",
        });
      }),
  );

  it.effect(
    "passes the settings it was given for the session and restores them after",
    () =>
      Effect.gen(function* () {
        process.env["FIXTURE_LEVEL"] = "outside";
        yield* Effect.scoped(
          within(
            backend.layer({ config }),
            Effect.sync(() => {
              expect(process.env["FIXTURE_ORIGIN"]).toBe(
                "https://fixture.test",
              );
              expect(process.env["FIXTURE_LEVEL"]).toBeUndefined();
            }),
          ),
        );
        expect(process.env["FIXTURE_ORIGIN"]).toBeUndefined();
        expect(process.env["FIXTURE_LEVEL"]).toBe("outside");
        delete process.env["FIXTURE_LEVEL"];
      }),
  );
});

const canary = "canary-backend-3f81c2d4";

const vaulted = TestBackend.make(
  {
    ...appOf(),
    convexSchema: defineSchema({
      seen: defineTable({ entry: v.string() }),
      tokens: defineTable({ token: v.string() }),
    }) as never,
    secrets: {
      tables: {
        "": {
          tokens: () =>
            Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) }),
        },
      },
    },
  },
  {
    refs: {},
    groups: {},
    ports: {},
    laws: [],
    obligations: [],
    manifestDigest: "sha256:vaulted",
    mounts: [],
    settings,
  },
);

describe("TestBackend.layer's redaction", () => {
  it.effect(
    "gives the kernel the registry's secret policy, so a stored secret reaches a failure report as a marker",
    () =>
      Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof host>();
        const ctx = MutationCtx.MutationCtx<GenericDataModel>();
        yield* test.run(
          Effect.flatMap(ctx, (raw) =>
            Effect.promise(() => raw.db.insert("tokens", { token: canary })),
          ),
        );
        const exit = yield* Effect.exit(
          test.run(
            Effect.flatMap(ctx, (raw) =>
              Effect.promise(() =>
                raw.db
                  .query("tokens")
                  .first()
                  .then((row) => {
                    throw new Error(
                      `the stored token is ${row!["token"] as string}`,
                    );
                  }),
              ),
            ),
          ),
        );
        assertIs(exit, Exit.isFailure);
        const report = Cause.pretty(exit.cause);
        expect(report).toContain("the stored token is [redacted]");
        expect(report).not.toContain(canary);
      }).pipe((body) => within(vaulted.layer({ config }), body)),
  );
});

const tasksSpec = GroupSpec.make()
  .addFunction(
    FunctionSpec.publicQuery({ name: "mine", returns: () => Schema.Null }),
  )
  .addFunction(
    FunctionSpec.publicMutation({ name: "assign", returns: () => Schema.Null }),
  );
const tasks = {
  mine: Ref.make("tasks/tasks", tasksSpec.functions.mine),
  assign: Ref.make("tasks/tasks", tasksSpec.functions.assign),
};
const typed = TestBackend.make(appOf(), {
  refs: { public: { tasks: { tasks } } },
  groups: {
    "tasks/tasks": TestBackend.group({
      path: "tasks/tasks",
      owner: "product",
      functions: tasks,
      open: ["mine"],
    }),
  },
  ports: {
    mail: TestBackend.port({
      name: "mail",
      input: Schema.Struct({ to: Schema.String }),
      outcomes: ["sent", "bounced"],
    }),
  },
  laws: [{ law: "decodes", table: "tasks" }],
  obligations: [{ kind: "access", group: "tasks/tasks" }, { kind: "realm" }],
  manifestDigest: "sha256:typed",
  mounts: [],
  settings,
});

describe("TestBackend's types", () => {
  it("keeps each group's functions and its open list", () => {
    type Tasks = (typeof typed.groups)["tasks/tasks"];
    expectTypeOf<keyof TestBackend.Functions<Tasks>>().toEqualTypeOf<
      "mine" | "assign"
    >();
    expectTypeOf<TestBackend.Open<Tasks>>().toEqualTypeOf<"mine">();
    // A row map total over the group's functions must name each one.
    const rows: Record<keyof TestBackend.Functions<Tasks>, true> = {
      mine: true,
      // @ts-expect-error A new function is a missing row.
      archive: true,
    };
    expect(rows.mine).toBe(true);
    TestBackend.group({
      path: "tasks/tasks",
      owner: "product",
      functions: tasks,
      // @ts-expect-error An open function must be one of the group's.
      open: ["archive"],
    });
    TestBackend.group({
      path: "tasks/tasks",
      // @ts-expect-error An owner is the product or a door.
      owner: "battery",
      functions: tasks,
      open: [],
    });
  });

  it("keeps each obligation, port outcome and required setting by name", () => {
    expectTypeOf<TestBackend.Owed<typeof typed>>().toEqualTypeOf<
      | { readonly kind: "access"; readonly group: "tasks/tasks" }
      | { readonly kind: "realm" }
    >();
    expectTypeOf(typed.ports.mail.outcomes[0]).toEqualTypeOf<
      "sent" | "bounced"
    >();
    expectTypeOf<TestBackend.Config<typeof settings>>().toEqualTypeOf<
      { readonly FIXTURE_ORIGIN: string } & {
        readonly FIXTURE_LEVEL?: string;
      }
    >();
    // @ts-expect-error A required setting cannot be left out.
    typed.layer({ config: {} });
  });
});

/**
 * A component whose `read` reports the settings named in `keys` as its
 * environment holds them, `null` for an unset one, whose `leak` throws with the
 * value of `leaked`, and whose `childRead` and `childLeak` do the same in the
 * child it mounts.
 */
const reader = (keys: ReadonlyArray<string>, leaked: string) => ({
  "_generated/server.ts": () => Promise.resolve({}),
  "state.ts": () =>
    Promise.resolve({
      read: queryGeneric({
        args: {},
        handler: () =>
          Promise.resolve(
            Arr.join(
              Arr.map(keys, (key) =>
                key in process.env ? `${key}=${process.env[key]}` : key,
              ),
              "\n",
            ),
          ),
      }),
      leak: mutationGeneric({
        args: {},
        handler: () => {
          throw new Error(`the setting is ${process.env[leaked]}`);
        },
      }),
      childRead: queryGeneric({
        args: {},
        handler: (ctx): Promise<string> =>
          ctx.runQuery(below.child.state.read, {}),
      }),
      childLeak: mutationGeneric({
        args: {},
        handler: (ctx) => ctx.runMutation(below.child.state.leak, {}),
      }),
    }),
});

interface ReaderApi {
  readonly read: Query<string>;
  readonly leak: Mutation<{}>;
  readonly childRead: Query<string>;
  readonly childLeak: Mutation<{}>;
}

// A component's references to its own mounts are relative to it.
const below = componentsGeneric() as unknown as {
  readonly child: { readonly state: ReaderApi };
};

const opened = componentsGeneric() as unknown as {
  readonly ledger: { readonly state: ReaderApi };
  readonly relay: {
    readonly state: ReaderApi;
    readonly child: { readonly state: ReaderApi };
  };
};

/**
 * The manifest of a host modelled on Frame's observe host: its `ledger` mount
 * leaves `OBSERVE`, `info` or `warn`, open as `LEDGER_OBSERVE`, and its `relay`
 * mount leaves its own provider choice and its child's `OPEN_SECRET`, promoted
 * as `CHILD_OPEN_SECRET`, open. The child's `STAGE` and `SIGNING_KEY` are
 * automatic, so every parent binds them and the root declares them once.
 */
const openManifest = {
  format: 1,
  name: "observe",
  env: {
    STAGE: { kind: "string", optional: false, automatic: true },
    SIGNING_KEY: { kind: "secret", optional: false, automatic: true },
  },
  mounts: {
    ledger: {
      component: "ledger",
      env: {
        OBSERVE: {
          kind: "literals",
          values: ["info", "warn"],
          optional: false,
          variable: "LEDGER_OBSERVE",
        },
        NOTE: { kind: "string", optional: true, variable: "LEDGER_NOTE" },
      },
    },
    relay: {
      component: "relay",
      env: {
        CHILD_OPEN_SECRET: {
          kind: "secret",
          optional: false,
          variable: "RELAY_CHILD_OPEN_SECRET",
        },
        EMAIL_PROVIDER: {
          kind: "providers",
          values: ["ses", "resend"],
          optional: true,
          variable: "RELAY_EMAIL_PROVIDER",
        },
        SES_KEY: {
          kind: "secret",
          optional: true,
          provider: { selector: "EMAIL_PROVIDER", name: "ses", required: true },
          variable: "RELAY_SES_KEY",
        },
        RESEND_API_KEY: {
          kind: "secret",
          optional: true,
          provider: {
            selector: "EMAIL_PROVIDER",
            name: "resend",
            required: true,
          },
          variable: "RELAY_RESEND_API_KEY",
        },
      },
    },
  },
  http: {},
  digest: "sha256:open",
  sections: {},
} as const;

const relaySlots = [
  "CHILD_OPEN_SECRET",
  "EMAIL_PROVIDER",
  "SES_KEY",
  "RESEND_API_KEY",
  "STAGE",
  "SIGNING_KEY",
] as const;
const childSlots = ["OPEN_SECRET", "STAGE", "SIGNING_KEY"] as const;

/**
 * Each mount bound as codegen binds it from the declarations that wrote the
 * manifest: an open slot to its deployment variable, an automatic one to the
 * root's own, and the child's to the names its parent declares.
 */
const openMounts: ReadonlyArray<TestBackend.Mount> = [
  {
    path: "ledger",
    kit: "local",
    env: { NOTE: { from: "LEDGER_NOTE" }, OBSERVE: { from: "LEDGER_OBSERVE" } },
    required: ["OBSERVE"],
  },
  {
    path: "relay",
    kit: "local",
    env: {
      CHILD_OPEN_SECRET: { from: "RELAY_CHILD_OPEN_SECRET" },
      EMAIL_PROVIDER: { from: "RELAY_EMAIL_PROVIDER" },
      RESEND_API_KEY: { from: "RELAY_RESEND_API_KEY" },
      SES_KEY: { from: "RELAY_SES_KEY" },
      SIGNING_KEY: { from: "SIGNING_KEY" },
      STAGE: { from: "STAGE" },
    },
    required: ["CHILD_OPEN_SECRET", "SIGNING_KEY", "STAGE"],
  },
  {
    path: "relay/child",
    kit: "local",
    env: {
      OPEN_SECRET: { from: "CHILD_OPEN_SECRET" },
      SIGNING_KEY: { from: "SIGNING_KEY" },
      STAGE: { from: "STAGE" },
    },
    required: ["OPEN_SECRET", "SIGNING_KEY", "STAGE"],
  },
];

const openSubject = TestBackend.make(
  {
    ...appOf({ deploy: false }),
    components: {
      ledger: {
        schema: logSchema,
        modules: reader(["OBSERVE", "NOTE"], "OBSERVE"),
      },
      relay: { schema: logSchema, modules: reader(relaySlots, "SIGNING_KEY") },
      "relay/child": {
        schema: logSchema,
        modules: reader(childSlots, "OPEN_SECRET"),
      },
    },
  },
  {
    refs: {},
    groups: {},
    ports: {},
    laws: [],
    obligations: [],
    manifestDigest: openManifest.digest,
    manifest: openManifest,
    mounts: openMounts,
    settings,
  },
);

const childCanary = "canary-mounts-6c0d93a1";
const signingCanary = "canary-automatic-1e7f52b8";

const supplied = {
  mounts: {
    ledger: { OBSERVE: "info" },
    relay: { CHILD_OPEN_SECRET: Redacted.make(childCanary) },
  },
  automatic: { STAGE: "staging", SIGNING_KEY: Redacted.make(signingCanary) },
} as const;

const readAs = (reference: Query<string>) =>
  Effect.gen(function* () {
    const test = yield* TestConfect.TestConfect<typeof host>();
    const read = yield* query(test, reference);
    // Each line is `KEY=value`, or `KEY` alone for an unset setting.
    return Rec.fromEntries(
      Arr.map(pipe(read, Str.split("\n")), (line) => {
        const [key, ...value] = pipe(line, Str.split("="));
        return [key, value.length === 0 ? null : Arr.join(value, "=")] as const;
      }),
    );
  });

/**
 * The layer's failure for `options`, with `config` and the `supplied` values in
 * place of any left out.
 */
const refusal = (options: {
  readonly mounts?: unknown;
  readonly automatic?: unknown;
}) =>
  Layer.build(
    openSubject.layer({
      config,
      mounts: (options.mounts ?? supplied.mounts) as never,
      automatic: (options.automatic ?? supplied.automatic) as never,
    }),
  ).pipe(Effect.flip);

describe("TestBackend.layer's open slots", () => {
  it.effect(
    "gives a mount's open slot the value layer({ mounts }) supplies, under the name the component reads, and leaves an optional one it omits unset",
    () =>
      Effect.gen(function* () {
        const ledger = yield* readAs(opened.ledger.state.read);
        expect(ledger).toEqual({ OBSERVE: "info", NOTE: null });
        // The deployment variable is the stack's; neither the app nor a
        // component reads it.
        expect(process.env["LEDGER_OBSERVE"]).toBeUndefined();
      }).pipe((body) =>
        within(openSubject.layer({ config, ...supplied }), body),
      ),
  );

  it.effect(
    "delivers a nested child's promoted slot through its parent, and an automatic slot through every parent",
    () =>
      Effect.gen(function* () {
        const relay = yield* readAs(opened.relay.state.read);
        expect(relay).toEqual({
          CHILD_OPEN_SECRET: childCanary,
          EMAIL_PROVIDER: null,
          SES_KEY: null,
          RESEND_API_KEY: null,
          STAGE: "staging",
          SIGNING_KEY: signingCanary,
        });
        const child = yield* readAs(opened.relay.state.childRead);
        expect(child).toEqual({
          OPEN_SECRET: childCanary,
          STAGE: "staging",
          SIGNING_KEY: signingCanary,
        });
      }).pipe((body) =>
        within(openSubject.layer({ config, ...supplied }), body),
      ),
  );

  it.effect.each([
    {
      label: "a mount's required slot",
      mounts: { relay: supplied.mounts.relay },
      automatic: undefined,
      setting: "OBSERVE",
      owner: "the mount ledger",
      supply: "mounts.ledger.OBSERVE",
    },
    {
      label: "a nested child's promoted slot",
      mounts: { ledger: supplied.mounts.ledger },
      automatic: undefined,
      setting: "CHILD_OPEN_SECRET",
      owner: "the mount relay",
      supply: "mounts.relay.CHILD_OPEN_SECRET",
    },
    {
      label: "an automatic slot",
      mounts: undefined,
      automatic: { SIGNING_KEY: supplied.automatic.SIGNING_KEY },
      setting: "STAGE",
      owner: "observe",
      supply: "automatic.STAGE",
    },
  ])(
    "refuses to open without $label, naming the mount and the slot",
    ({ mounts, automatic, setting, owner, supply }) =>
      Effect.gen(function* () {
        const error = yield* refusal({ mounts, automatic });
        expect(error).toMatchObject({
          _tag: "TestConfigMissing",
          setting,
          owner,
          supply,
          docs: "https://confect.dev/guides/testing#configuration",
        });
        expect(error.message).toContain(`as ${supply} in layer()`);
      }),
  );

  it.effect.each([
    { label: '""', value: "" },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
  ])("counts $label for a required slot as missing", ({ value }) =>
    Effect.gen(function* () {
      const error = yield* refusal({
        mounts: { ...supplied.mounts, ledger: { OBSERVE: value } },
      });
      expect(error).toMatchObject({
        _tag: "TestConfigMissing",
        setting: "OBSERVE",
        supply: "mounts.ledger.OBSERVE",
      });
    }),
  );

  it.effect("counts an empty Redacted for a secret as missing", () =>
    Effect.gen(function* () {
      const error = yield* refusal({
        mounts: {
          ...supplied.mounts,
          relay: { CHILD_OPEN_SECRET: Redacted.make("") },
        },
      });
      expect(error).toMatchObject({
        _tag: "TestConfigMissing",
        setting: "CHILD_OPEN_SECRET",
        supply: "mounts.relay.CHILD_OPEN_SECRET",
      });
    }),
  );

  it.effect(
    "does not write an optional slot given null or an empty string",
    () =>
      Effect.gen(function* () {
        const ledger = yield* readAs(opened.ledger.state.read);
        expect(ledger).toEqual({ OBSERVE: "warn", NOTE: null });
      }).pipe((body) =>
        within(
          openSubject.layer({
            config,
            ...supplied,
            mounts: {
              ...supplied.mounts,
              ledger: { OBSERVE: "warn", NOTE: "" },
            },
          }),
          body,
        ),
      ),
  );

  it.effect.each([
    {
      label: "a literals slot given a value it does not list",
      mounts: { ...supplied.mounts, ledger: { OBSERVE: "debug" } },
      automatic: undefined,
      reason: "InvalidValue",
      setting: "OBSERVE",
      supply: "mounts.ledger.OBSERVE",
      value: "debug",
    },
    {
      label: "a string slot given a number",
      mounts: {
        ...supplied.mounts,
        ledger: { OBSERVE: "info", NOTE: 4096 },
      },
      automatic: undefined,
      reason: "InvalidValue",
      setting: "NOTE",
      supply: "mounts.ledger.NOTE",
      value: "4096",
    },
    {
      label: "a mount's secret given a plain string",
      mounts: {
        ...supplied.mounts,
        relay: { CHILD_OPEN_SECRET: "plain-mount-secret" },
      },
      automatic: undefined,
      reason: "PlainSecret",
      setting: "CHILD_OPEN_SECRET",
      supply: "mounts.relay.CHILD_OPEN_SECRET",
      value: "plain-mount-secret",
    },
    {
      label: "an automatic secret given a plain string",
      mounts: undefined,
      automatic: { STAGE: "staging", SIGNING_KEY: "plain-automatic-secret" },
      reason: "PlainSecret",
      setting: "SIGNING_KEY",
      supply: "automatic.SIGNING_KEY",
      value: "plain-automatic-secret",
    },
    {
      label: "a mount the manifest does not list",
      mounts: { ...supplied.mounts, archive: { OBSERVE: "info" } },
      automatic: undefined,
      reason: "UnknownMount",
      setting: undefined,
      supply: "mounts.archive",
      value: "info",
    },
    {
      label: "a slot the manifest does not leave open",
      mounts: {
        ...supplied.mounts,
        ledger: { OBSERVE: "info", LEVEL: "loud-level" },
      },
      automatic: undefined,
      reason: "NotOpen",
      setting: "LEVEL",
      supply: "mounts.ledger.LEVEL",
      value: "loud-level",
    },
    {
      label:
        "an automatic value for a slot the root does not declare automatic",
      mounts: undefined,
      automatic: { ...supplied.automatic, REGION: "eu-west-1" },
      reason: "NotAutomatic",
      setting: "REGION",
      supply: "automatic.REGION",
      value: "eu-west-1",
    },
  ])(
    "refuses $label as Backend does, naming the slot and never the value",
    ({ mounts, automatic, reason, setting, supply, value }) =>
      Effect.gen(function* () {
        const error = yield* refusal({ mounts, automatic });
        expect(error).toMatchObject({
          _tag: "TestConfigInvalid",
          reason,
          supply,
          ...(setting === undefined ? {} : { setting }),
        });
        expect(error.message).not.toContain(value);
        expect(
          pipe(
            ["setting", "owner", "supply", "reason"] as const,
            Arr.map((field) => String(error[field as keyof typeof error])),
            Arr.join(" "),
          ),
        ).not.toContain(value);
      }),
  );

  it.effect.each([
    {
      label: "a provider's name",
      relay: { EMAIL_PROVIDER: "ses", SES_KEY: Redacted.make("ses-key") },
      choice: "ses",
      keys: { SES_KEY: "ses-key", RESEND_API_KEY: null },
    },
    {
      label: "an active provider with standbys",
      relay: {
        EMAIL_PROVIDER: { active: "resend", standby: ["ses"] },
        SES_KEY: Redacted.make("ses-key"),
        RESEND_API_KEY: Redacted.make("resend-key"),
      },
      choice: { active: "resend", standby: ["ses"] },
      keys: { SES_KEY: "ses-key", RESEND_API_KEY: "resend-key" },
    },
    {
      label: "a pool",
      relay: {
        EMAIL_PROVIDER: { pool: ["ses", "resend"] },
        SES_KEY: Redacted.make("ses-key"),
        RESEND_API_KEY: Redacted.make("resend-key"),
      },
      choice: { pool: ["ses", "resend"] },
      keys: { SES_KEY: "ses-key", RESEND_API_KEY: "resend-key" },
    },
  ] as const)(
    "delivers a provider choice of $label encoded as Backend writes it",
    ({ relay, choice, keys }) =>
      Effect.gen(function* () {
        const read = yield* readAs(opened.relay.state.read);
        const written = yield* Schema.encodeEffect(
          Env.providerChoice(["ses", "resend"]),
        )(choice);
        expect(read).toMatchObject({ EMAIL_PROVIDER: written, ...keys });
      }).pipe((body) =>
        within(
          openSubject.layer({
            config,
            ...supplied,
            mounts: {
              ...supplied.mounts,
              relay: { ...supplied.mounts.relay, ...relay } as never,
            },
          }),
          body,
        ),
      ),
  );

  it.effect.each([
    {
      label: "a choice naming a provider without its required setting",
      relay: {
        EMAIL_PROVIDER: { pool: ["ses", "resend"] },
        SES_KEY: Redacted.make("ses-key"),
      },
      tag: "TestConfigMissing",
      setting: "RESEND_API_KEY",
    },
    {
      label: "a provider the selector does not offer",
      relay: { EMAIL_PROVIDER: "smtp" },
      tag: "TestConfigInvalid",
      setting: "EMAIL_PROVIDER",
    },
    {
      label: "an active provider that is also a standby",
      relay: {
        EMAIL_PROVIDER: { active: "ses", standby: ["ses"] },
        SES_KEY: Redacted.make("ses-key"),
      },
      tag: "TestConfigInvalid",
      setting: "EMAIL_PROVIDER",
    },
  ])("refuses $label", ({ relay, tag, setting }) =>
    Effect.gen(function* () {
      const error = yield* refusal({
        mounts: {
          ...supplied.mounts,
          relay: { ...supplied.mounts.relay, ...relay },
        },
      });
      expect(error).toMatchObject({
        _tag: tag,
        setting,
        supply: `mounts.relay.${setting}`,
        ...(tag === "TestConfigInvalid" ? { reason: "InvalidChoice" } : {}),
      });
    }),
  );

  it.effect.each([
    {
      label: "a secret arriving through mounts, in the nested child it reaches",
      leak: opened.relay.state.childLeak,
      secret: childCanary,
    },
    {
      label: "a secret arriving through automatic",
      leak: opened.relay.state.leak,
      secret: signingCanary,
    },
  ])(
    "marks $label as an app's secret is marked in a failure report",
    ({ leak, secret }) =>
      Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof host>();
        const exit = yield* Effect.exit(
          test.run(
            Effect.flatMap(MutationCtx.MutationCtx<GenericDataModel>(), (raw) =>
              Effect.promise(() => raw.runMutation(leak, {})),
            ),
          ),
        );
        assertIs(exit, Exit.isFailure);
        const report = Cause.pretty(exit.cause);
        expect(report).toContain("the setting is [redacted]");
        expect(report).not.toContain(secret);
      }).pipe((body) =>
        within(openSubject.layer({ config, ...supplied }), body),
      ),
  );
});

describe("TestBackend.layer's open-slot types", () => {
  it("requires each required open slot and automatic slot, and refuses a slot or mount the manifest does not list", () => {
    type Options = TestBackend.LayerOptions<
      typeof host,
      typeof settings,
      typeof openManifest
    >;
    expectTypeOf<NonNullable<Options["mounts"]>["ledger"]>().toEqualTypeOf<
      { readonly OBSERVE: "info" | "warn" } & { readonly NOTE?: string }
    >();
    expectTypeOf<NonNullable<Options["automatic"]>>().toEqualTypeOf<{
      readonly STAGE: string;
      readonly SIGNING_KEY: Redacted.Redacted<string>;
    }>();
    const layer = openSubject.layer;
    // @ts-expect-error A required open slot is required by the type.
    layer({ config, ...supplied, mounts: { ...supplied.mounts, ledger: {} } });
    layer({
      config,
      automatic: supplied.automatic,
      // @ts-expect-error A mount with a required open slot cannot be left out.
      mounts: { relay: supplied.mounts.relay },
    });
    // @ts-expect-error The mounts holding required slots cannot be left out.
    layer({ config, automatic: supplied.automatic });
    // @ts-expect-error The automatic slots cannot be left out.
    layer({ config, mounts: supplied.mounts });
    layer({
      config,
      ...supplied,
      mounts: {
        ...supplied.mounts,
        // @ts-expect-error A literals slot takes one of its values.
        ledger: { OBSERVE: "debug" },
      },
    });
    layer({
      config,
      ...supplied,
      mounts: {
        // @ts-expect-error A slot the manifest does not leave open is refused.
        ledger: { OBSERVE: "info", LEVEL: "loud" },
        relay: supplied.mounts.relay,
      },
    });
    layer({
      config,
      ...supplied,
      mounts: {
        ...supplied.mounts,
        // @ts-expect-error A secret takes a Redacted string.
        relay: { CHILD_OPEN_SECRET: "plain" },
      },
    });
    layer({
      config,
      ...supplied,
      // @ts-expect-error A mount the manifest does not list is refused.
      mounts: { ...supplied.mounts, archive: {} },
    });
    expect(layer).toBeTypeOf("function");
  });

  it("takes neither for a subject without a manifest, nor for one whose manifest leaves nothing open", () => {
    type Bare = Parameters<typeof backend.layer>[0];
    expectTypeOf<Bare["mounts"]>().toEqualTypeOf<undefined>();
    expectTypeOf<Bare["automatic"]>().toEqualTypeOf<undefined>();
    const closed = TestBackend.make(appOf(), {
      refs: {},
      groups: {},
      ports: {},
      laws: [],
      obligations: [],
      manifestDigest: "sha256:closed",
      manifest: {
        format: 1,
        name: "closed",
        env: {},
        mounts: {
          ledger: {
            component: "ledger",
            env: {
              NOTE: { kind: "string", optional: true, variable: "LEDGER_NOTE" },
            },
          },
        },
        http: {},
        digest: "sha256:closed",
        sections: {},
      },
      mounts: [],
      settings,
    });
    // Neither input is required when no slot is.
    closed.layer({ config });
    closed.layer({ config, mounts: { ledger: { NOTE: "note" } } });
    expect(closed.kind).toBe("app");
  });
});

describe("TestBackend.layer's mapping of core's refusals", () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const target = "src/internal/Backend.ts";

  it.effect("compiles against Manifest.variables as it is", () =>
    Effect.gen(function* () {
      const diagnostics = yield* diagnosticsOf(packageRoot, target);
      expect(diagnostics).toEqual([]);
    }).pipe(Effect.provide([NodeServices.layer])),
  );

  it.effect.each(["reason", "refusal"] as const)(
    "stops compiling when Manifest.variables returns a %s no case handles",
    (widening) =>
      Effect.gen(function* () {
        const diagnostics = yield* diagnosticsOf(packageRoot, target, {
          check: "variables",
          widening,
        });
        expect(diagnostics).not.toEqual([]);
      }).pipe(Effect.provide([NodeServices.layer])),
    { timeout: 60000 },
  );
});

/**
 * A subject whose manifest leaves only `ledger` open, and one whose manifest
 * leaves nothing open.
 */
const ledgerOnly = TestBackend.make(openSubject.app, {
  ...openSubject,
  manifest: {
    ...openManifest,
    env: {},
    mounts: { ledger: openManifest.mounts.ledger },
  },
});
const nothingOpen = TestBackend.make(openSubject.app, {
  ...openSubject,
  manifest: { ...openManifest, env: {}, mounts: {} },
});

describe("TestBackend.layer's exact keys, as Backend checks them", () => {
  it("refuses a mount the manifest does not list, written inline or passed through a variable", () => {
    const mounts = { ledger: { OBSERVE: "info" as const }, typo: {} };
    // @ts-expect-error `typo` is no mount of the manifest.
    ledgerOnly.layer({ config, mounts });
    // @ts-expect-error The manifest lists no mount at all.
    nothingOpen.layer({ config, mounts: { typo: {} } });
    const typo = { typo: {} };
    // @ts-expect-error Neither through a variable.
    nothingOpen.layer({ config, mounts: typo });
    const listed = { ledger: { OBSERVE: "info" as const } };
    ledgerOnly.layer({ config, mounts: listed });
    nothingOpen.layer({ config, mounts: {} });
    expect(listed.ledger.OBSERVE).toBe("info");
  });

  it("refuses a slot a mount does not leave open, through a variable too", () => {
    const mounts = { ledger: { OBSERVE: "info" as const, LEVEL: "loud" } };
    // @ts-expect-error `LEVEL` is no open slot of `ledger`.
    ledgerOnly.layer({ config, mounts });
    expect(mounts.ledger.LEVEL).toBe("loud");
  });

  it("refuses a slot the root does not declare automatic, inline or through a variable", () => {
    const automatic = { ...supplied.automatic, REGION: "eu-west-1" };
    const layer = openSubject.layer;
    // @ts-expect-error `REGION` is not automatic.
    layer({ config, mounts: supplied.mounts, automatic });
    layer({
      config,
      mounts: supplied.mounts,
      // @ts-expect-error Nor written inline.
      automatic: { ...supplied.automatic, REGION: "eu-west-1" },
    });
    // @ts-expect-error A manifest with no automatic slot takes none.
    nothingOpen.layer({ config, automatic: { STAGE: "staging" } });
    expect(automatic.REGION).toBe("eu-west-1");
  });
});

/**
 * The open subject, with `STAGE` and `SIGNING_KEY` the app's own
 * `Env.automatic` settings as well as its manifest's automatic slots.
 */
const ownSettings = [
  ...settings,
  { name: "STAGE", owner: "observe", optional: false, automatic: true },
  { name: "SIGNING_KEY", owner: "observe", optional: false, automatic: true },
] as const;
const ownAutomatic = TestBackend.make(openSubject.app, {
  ...openSubject,
  settings: ownSettings,
});

describe("An app's own Env.automatic setting", () => {
  it("is supplied through automatic, never config, as Backend.env leaves it to Backend.automatic", () => {
    expectTypeOf<TestBackend.Config<typeof ownSettings>>().toEqualTypeOf<
      { readonly FIXTURE_ORIGIN: string } & { readonly FIXTURE_LEVEL?: string }
    >();
    const inConfig = { ...config, STAGE: "from-config" };
    // @ts-expect-error The app's own automatic setting is refused in config.
    ownAutomatic.layer({ ...supplied, config: inConfig });
    ownAutomatic.layer({
      ...supplied,
      // @ts-expect-error Written inline too.
      config: { ...config, STAGE: "from-config" },
    });
    expect(inConfig.STAGE).toBe("from-config");
  });

  it.effect("reaches the app from automatic for the session", () =>
    Effect.sync(() => {
      expect(process.env["STAGE"]).toBe("staging");
    }).pipe((body) =>
      within(ownAutomatic.layer({ config, ...supplied }), body),
    ),
  );

  it.effect(
    "ignores a value smuggled into config, as Backend ignores one in env",
    () =>
      Effect.sync(() => {
        expect(process.env["STAGE"]).toBe("staging");
      }).pipe((body) =>
        within(
          ownAutomatic.layer({
            ...supplied,
            config: { ...config, STAGE: "from-config" } as typeof config,
          }),
          body,
        ),
      ),
  );

  it.effect(
    "is missing when only config holds it, naming automatic as where it goes",
    () =>
      Effect.gen(function* () {
        const error = yield* Layer.build(
          ownAutomatic.layer({
            mounts: supplied.mounts,
            config: { ...config, STAGE: "from-config" } as typeof config,
            automatic: { SIGNING_KEY: supplied.automatic.SIGNING_KEY } as never,
          }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "TestConfigMissing",
          setting: "STAGE",
          supply: "automatic.STAGE",
        });
      }),
  );
});

const restoredChild = "canary-restored-mounts-4b9e0c27";
const restoredSigning = "canary-restored-automatic-8d13f6a5";

describe("TestBackend.layer's secrets after a snapshot restore", () => {
  /**
   * A session of the open subject, its kernel exposed, with `values`.
   */
  const sessionOf = (values: {
    readonly mounts: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    readonly automatic: Readonly<Record<string, unknown>>;
  }) =>
    openSession(openSubject.app, openSubject, config, undefined, {
      supplied: values,
    });

  it.effect.each([
    {
      label: "through mounts, in the nested child it reaches",
      leak: opened.relay.state.childLeak,
      secret: restoredChild,
    },
    {
      label: "through automatic",
      leak: opened.relay.state.leak,
      secret: restoredSigning,
    },
  ])(
    "keeps a secret supplied $label marked once a snapshot from a session with other values is restored",
    ({ leak, secret }) =>
      Effect.gen(function* () {
        const source = yield* sessionOf(supplied);
        const snapshot: Uint8Array = source.raw.exportSnapshot();
        const kept: unknown = source.raw.secrets();
        const target = yield* sessionOf({
          mounts: {
            ...supplied.mounts,
            relay: { CHILD_OPEN_SECRET: Redacted.make(restoredChild) },
          },
          automatic: {
            STAGE: "restored",
            SIGNING_KEY: Redacted.make(restoredSigning),
          },
        });
        yield* Effect.promise((): Promise<void> =>
          target.raw.restoreSnapshot(snapshot, { secrets: kept }),
        );
        const exit = yield* Effect.exit(
          target.service.run(
            Effect.flatMap(MutationCtx.MutationCtx<GenericDataModel>(), (raw) =>
              Effect.promise(() => raw.runMutation(leak, {})),
            ),
          ),
        );
        assertIs(exit, Exit.isFailure);
        const report = Cause.pretty(exit.cause);
        expect(report).toContain("the setting is [redacted]");
        expect(report).not.toContain(secret);
      }).pipe(Effect.scoped),
  );
});

describe("TestBackend.layer's push checks", () => {
  /**
   * A subject over `own`'s graph and its registry, with a component `guarded`
   * over `child`'s graph and no mount init.
   */
  const subjectOf = (
    own: ReturnType<typeof pushChecked>,
    child: ReturnType<typeof pushChecked>,
  ) =>
    TestBackend.make(
      {
        schema: own.schema,
        convexSchema: own.convexSchema as never,
        httpMounts: [],
        modules: own.modules,
        components: {
          guarded: { schema: child.convexSchema, modules: child.modules },
        },
      },
      {
        refs: {},
        groups: {},
        ports: {},
        laws: [],
        obligations: [],
        manifestDigest: "sha256:fixture",
        mounts: [{ path: "guarded", kit: "local", env: {}, required: [] }],
        settings: [],
      },
    );
  const seeded = { count: 0 };
  const seedOnce = Effect.sync(() => {
    seeded.count++;
  });
  const built = <ROut, E>(layer: Layer.Layer<ROut, E>) =>
    layer.pipe(Layer.build, Effect.asVoid, Effect.exit);
  const fetchHello = Effect.gen(function* () {
    const test =
      yield* TestConfect.TestConfect<
        ReturnType<typeof pushChecked>["schema"]
      >();
    const response = yield* test.fetch("/hello");
    return response.status;
  });

  it.effect(
    "refuses to open a source the app's or a component's push check refuses, before any init or seed",
    () =>
      Effect.gen(function* () {
        seeded.count = 0;
        const refusedApp = yield* built(
          subjectOf(
            pushChecked({ refusals: [pushCheckRefusal] }),
            pushChecked({ name: "component" }),
          ).layer({ config: {}, seed: seedOnce }),
        );
        diedWith(
          refusedApp,
          PushCheck.PushRefused.make({
            check: "authz",
            refusals: [pushCheckRefusal],
          }),
        );
        const refusedComponent = yield* built(
          subjectOf(
            pushChecked(),
            pushChecked({ name: "component", refusals: [pushCheckRefusal] }),
          ).layer({ config: {}, seed: seedOnce }),
        );
        diedWith(
          refusedComponent,
          PushCheck.PushRefused.make({
            check: "component",
            refusals: [pushCheckRefusal],
          }),
        );
        expect(seeded.count).toBe(0);
      }),
  );

  it.effect(
    'opens a source whose push checks pass, and a refused one with pushChecks: "skip", serving its HTTP routes',
    () =>
      Effect.gen(function* () {
        seeded.count = 0;
        const own = pushChecked();
        const child = pushChecked({ name: "component" });
        const passing = yield* within(
          subjectOf(own, child).layer({ config: {}, seed: seedOnce }),
          fetchHello,
        );
        expect(passing).toBe(200);
        expect([own.runs.check, child.runs.check]).toEqual([1, 1]);
        const refused = pushChecked({ refusals: [pushCheckRefusal] });
        const skipped = yield* within(
          subjectOf(refused, child).layer({
            config: {},
            seed: seedOnce,
            pushChecks: "skip",
          }),
          fetchHello,
        );
        expect(skipped).toBe(200);
        expect(refused.runs.check).toBe(0);
        expect(seeded.count).toBe(2);
      }),
  );
});
