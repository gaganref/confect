// oxlint-disable effecttsgo/async-function -- The fixtures are plain Convex functions, which are async as product code is.
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as MutationCtx from "@confect/server/MutationCtx";
import { TestBackend, TestConfect } from "@confect/test";
import { FunctionSpec, GroupSpec, Ref } from "@confect/core";
import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  componentsGeneric,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

declare const process: { env: Record<string, string | undefined> };

const components = componentsGeneric() as unknown as {
  readonly parent: {
    readonly state: {
      readonly log: FunctionReference<"query", "internal", {}, Array<string>>;
    };
  };
  readonly child: {
    readonly state: {
      readonly log: FunctionReference<"query", "internal", {}, Array<string>>;
    };
  };
};

const steps = (
  list: ReadonlyArray<{ path: string; nested: boolean; label: string | null }>,
) =>
  internalMutationGeneric({
    args: {},
    handler: async () =>
      list.map(({ path, nested, label }) => ({
        componentPath: path,
        nested,
        init:
          label === null ? null : { functionName: "init:run", args: { label } },
      })),
  });

const logSchema = defineSchema({ log: defineTable({ entry: v.string() }) });

/**
 * A component whose `init` records its label and what its child logged.
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
    : {}),
  "init.ts": () =>
    Promise.resolve({
      run: internalMutationGeneric({
        args: { label: v.string() },
        handler: async (ctx, { label }) => {
          const below: Array<string> = child
            ? await ctx.runQuery(components.child.state.log, {})
            : [];
          await ctx.db.insert("log", {
            entry: `${label} saw [${below.join(",")}]`,
          });
        },
      }),
    }),
  "state.ts": () =>
    Promise.resolve({
      log: queryGeneric({
        args: {},
        handler: async (ctx) =>
          (await ctx.db.query("log").collect()).map(({ entry }) => entry),
      }),
      tick: mutationGeneric({ args: {}, handler: async () => null }),
    }),
});

const host = DatabaseSchema.make({});
const hostSchema = defineSchema({ seen: defineTable({ entry: v.string() }) });

const app: TestConfect.DeclaredApp<typeof host> = {
  schema: host,
  convexSchema: hostSchema as never,
  httpMounts: [],
  modules: {
    "_generated/server.ts": () => Promise.resolve({}),
    "confectDeploy.ts": () =>
      Promise.resolve({
        steps: steps([{ path: "parent", nested: true, label: "parent" }]),
      }),
  },
  components: {
    parent: { schema: logSchema, modules: component(true) },
    "parent/child": {
      register: (t, name) =>
        t.registerComponent(name, logSchema, component(false), {
          standing: ["state:tick"],
        }),
    },
  },
};

const settings = [
  { name: "FIXTURE_ORIGIN", owner: "fixture", optional: false },
  { name: "FIXTURE_LEVEL", owner: "fixture", optional: true },
] as const;

const backend = TestBackend.make(app, {
  refs: {},
  groups: {},
  ports: {},
  laws: [],
  obligations: [],
  manifestDigest: "sha256:fixture",
  mounts: [
    { path: "parent/child", kit: "fixture-kit" },
    { path: "parent", kit: "local" },
  ],
  settings,
  secrets: { tables: {}, functions: {} },
});

const config = { FIXTURE_ORIGIN: "https://fixture.test" };

describe("TestBackend.layer", () => {
  it.effect(
    "runs a nested mount's init before its parent's, then the seed in one mutation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof host>();
        const session = yield* TestBackend.Session;
        expect(session.initialized).toEqual(["parent/child", "parent"]);
        expect(
          yield* test.run(
            Effect.gen(function* () {
              const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
              const rows = yield* Effect.promise(() =>
                ctx.db.query("seen").collect(),
              );
              return rows.map((row) => row["entry"] as string).join("\n");
            }),
            Schema.String,
          ),
        ).toBe("seed saw [parent saw [child saw []]]");
      }).pipe(
        Effect.provide(
          backend.layer({
            config,
            seed: Effect.gen(function* () {
              const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
              const log = yield* Effect.promise(() =>
                ctx.runQuery(components.parent.state.log, {}),
              );
              yield* Effect.promise(() =>
                ctx.db.insert("seen", { entry: `seed saw [${log.join(",")}]` }),
              );
            }),
          }),
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
    }).pipe(Effect.provide(backend.layer({ config }))),
  );

  it.effect(
    "refuses to open without a required setting, naming its owner and docs",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.provide(
            Effect.void,
            backend.layer({ config: {} as typeof config }),
          ),
        );
        assert(Exit.isFailure(exit));
        expect(exit.cause.toString()).toContain("TestConfigMissing");
        const error = yield* Effect.flip(
          Effect.provide(
            Effect.void,
            backend.layer({ config: {} as typeof config }),
          ),
        );
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
        yield* Effect.provide(
          Effect.sync(() => {
            expect(process.env["FIXTURE_ORIGIN"]).toBe("https://fixture.test");
            expect(process.env["FIXTURE_LEVEL"]).toBeUndefined();
          }),
          backend.layer({ config }),
        );
        expect(process.env["FIXTURE_ORIGIN"]).toBeUndefined();
        expect(process.env["FIXTURE_LEVEL"]).toBe("outside");
        delete process.env["FIXTURE_LEVEL"];
      }),
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
const typed = TestBackend.make(app, {
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
  secrets: { tables: {}, functions: {} },
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

  it("answers the kernel's secret policy from the generated paths", () => {
    const policy = TestBackend.secretPolicy({
      tables: { "": { keys: [["token"]] } },
      functions: { mailer: { "send:run": { args: [["key"]], returns: [] } } },
    });
    expect(policy.table("", "keys")).toEqual([["token"]]);
    expect(policy.table("mailer", "keys")).toEqual([]);
    expect(
      policy.args({ componentPath: "mailer", udfPath: "send:run" }),
    ).toEqual([["key"]]);
    expect(policy.returns({ componentPath: "", udfPath: "send:run" })).toEqual(
      [],
    );
  });
});
