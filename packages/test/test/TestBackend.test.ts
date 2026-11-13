import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as MutationCtx from "@confect/server/MutationCtx";
import { TestBackend, TestConfect } from "@confect/test";
import { FunctionSpec, GroupSpec, Ref } from "@confect/core";
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
import * as Schema from "effect/Schema";
import { assertIs } from "./internal/assertIs";

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
