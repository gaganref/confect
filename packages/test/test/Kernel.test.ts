// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of two fresh Node processes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as ActionCtx from "@confect/server/ActionCtx";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import type * as Handler from "@confect/server/Handler";
import * as MutationCtx from "@confect/server/MutationCtx";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { assert, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  actionGeneric,
  componentsGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { jsonToConvex, v, type GenericId } from "convex/values";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import type * as Execution from "../src/internal/Execution";
import * as Invocation from "../src/internal/Invocation";

type Latch = { readonly promise: Promise<void>; readonly release: () => void };

const latch = (): Latch => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: () => resolve() };
};

// Set by a test before it starts `writeBoth`, so the test can look at the
// world while the mutation is still in flight.
let reached = () => {};
let hold: Promise<void> = Promise.resolve();

const store = (componentsGeneric() as any).store as {
  readonly rows: {
    readonly add: FunctionReference<"mutation", "internal", { text: string }>;
    readonly addThenFail: FunctionReference<
      "mutation",
      "internal",
      { text: string }
    >;
    readonly list: FunctionReference<"query", "internal", {}, Array<string>>;
    readonly whoami: FunctionReference<"query", "internal", {}, string | null>;
    readonly whoamiThroughQuery: FunctionReference<
      "action",
      "internal",
      {},
      string | null
    >;
  };
};

const notes = {
  list: makeFunctionReference<"query", {}, Array<string>>("notes:list"),
  insertThenFail: makeFunctionReference<"mutation">("notes:insertThenFail"),
  keepAfterNestedFailure: makeFunctionReference<"mutation">(
    "notes:keepAfterNestedFailure",
  ),
  writeBoth: makeFunctionReference<"mutation", { fail: boolean }>(
    "notes:writeBoth",
  ),
  writeBesideNestedFailure: makeFunctionReference<"mutation">(
    "notes:writeBesideNestedFailure",
  ),
  rename: makeFunctionReference<"mutation", { id: string; text: string }>(
    "notes:rename",
  ),
  renameAfterNested: makeFunctionReference<"mutation", { id: string }>(
    "notes:renameAfterNested",
  ),
  renameBeforeNested: makeFunctionReference<
    "mutation",
    { id: string },
    string | null
  >("notes:renameBeforeNested"),
  insertThenList: makeFunctionReference<"mutation", {}, Array<string>>(
    "notes:insertThenList",
  ),
  textOf: makeFunctionReference<"query", { id: string }, string | null>(
    "notes:textOf",
  ),
  whoami: makeFunctionReference<"query", {}, string | null>("notes:whoami"),
  whoamiThroughQuery: makeFunctionReference<"action", {}, string | null>(
    "notes:whoamiThroughQuery",
  ),
  componentWhoami: makeFunctionReference<"action", {}, string | null>(
    "notes:componentWhoami",
  ),
};

const subjectOf = (ctx: {
  readonly auth: {
    getUserIdentity: () => Promise<{ subject: string } | null>;
  };
}) => ctx.auth.getUserIdentity().then((identity) => identity?.subject ?? null);

const hostSchema = defineSchema({ notes: defineTable({ text: v.string() }) });
const storeSchema = defineSchema({ rows: defineTable({ text: v.string() }) });

const storeModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "rows.ts": () =>
    Promise.resolve({
      add: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) =>
          ctx.db.insert("rows", { text }).then(() => null),
      }),
      addThenFail: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) =>
          ctx.db.insert("rows", { text }).then(() => {
            throw new Error("The component call failed.");
          }),
      }),
      list: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("rows")
            .collect()
            .then((rows) => rows.map((row) => row.text)),
      }),
      whoami: queryGeneric({ args: {}, handler: subjectOf }),
      whoamiThroughQuery: actionGeneric({
        args: {},
        handler: (ctx): Promise<string | null> =>
          ctx.runQuery(
            makeFunctionReference<"query", {}, string | null>("rows:whoami"),
            {},
          ),
      }),
    }),
};

const hostModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "notes.ts": () =>
    Promise.resolve({
      list: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("notes")
            .collect()
            .then((rows) => rows.map((row) => row.text)),
      }),
      insertThenFail: mutationGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db.insert("notes", { text: "lost" }).then(() => {
            throw new Error("The host mutation failed.");
          }),
      }),
      keepAfterNestedFailure: mutationGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .insert("notes", { text: "kept" })
            .then(() =>
              ctx
                .runMutation(store.rows.addThenFail, { text: "dropped" })
                .catch(() => null),
            )
            .then(() => null),
      }),
      writeBoth: mutationGeneric({
        args: { fail: v.boolean() },
        handler: (ctx, { fail }) =>
          ctx.db
            .insert("notes", { text: "host" })
            .then(() => ctx.runMutation(store.rows.add, { text: "component" }))
            .then(() => {
              reached();
              return hold;
            })
            .then(() => {
              if (fail) throw new Error("The host failed after its component.");
              return null;
            }),
      }),
      writeBesideNestedFailure: mutationGeneric({
        args: {},
        handler: (ctx) =>
          Promise.all([
            ctx
              .runMutation(store.rows.addThenFail, { text: "dropped" })
              .catch(() => null),
            ctx.db.insert("notes", { text: "beside" }),
          ]).then(() => null),
      }),
      rename: mutationGeneric({
        args: { id: v.id("notes"), text: v.string() },
        handler: (ctx, { id, text }) =>
          ctx.db.patch(id, { text }).then(() => null),
      }),
      renameAfterNested: mutationGeneric({
        args: { id: v.id("notes") },
        handler: (ctx, { id }) =>
          Promise.all([
            ctx.runMutation(notes.rename, { id, text: "child" }),
            ctx.db.patch(id, { text: "parent" }),
          ]).then(() => null),
      }),
      renameBeforeNested: mutationGeneric({
        args: { id: v.id("notes") },
        handler: (ctx, { id }) =>
          Promise.all([
            ctx.db.patch(id, { text: "parent" }),
            ctx
              .runQuery(notes.textOf, { id })
              .then((seen) =>
                ctx
                  .runMutation(notes.rename, { id, text: "child" })
                  .then(() => seen),
              ),
          ]).then(([, seen]) => seen),
      }),
      textOf: queryGeneric({
        args: { id: v.id("notes") },
        handler: (ctx, { id }) =>
          ctx.db.get(id).then((note) => note?.text ?? null),
      }),
      insertThenList: mutationGeneric({
        args: {},
        handler: (ctx) =>
          Promise.all([
            ctx.db.insert("notes", { text: "queued" }),
            ctx.db
              .query("notes")
              .collect()
              .then((rows) => rows.map((row) => row.text)),
          ]).then(([, texts]) => texts),
      }),
      whoami: queryGeneric({ args: {}, handler: subjectOf }),
      whoamiThroughQuery: actionGeneric({
        args: {},
        handler: (ctx): Promise<string | null> =>
          ctx.runQuery(notes.whoami, {}),
      }),
      componentWhoami: actionGeneric({
        args: {},
        handler: (ctx): Promise<string | null> =>
          ctx.runAction(store.rows.whoamiThroughQuery, {}),
      }),
    }),
};

const world = () => {
  const t = convexTest(hostSchema, hostModules);
  t.registerComponent("store", storeSchema, storeModules);
  return t;
};

const contents = (t: ReturnType<typeof world>) =>
  Effect.promise(() =>
    Promise.all([t.query(notes.list, {}), t.query(store.rows.list, {})]),
  );

describe("rollback", () => {
  it.effect("a mutation that throws publishes none of its writes", () =>
    Effect.gen(function* () {
      const t = world();
      const failed = yield* Effect.promise(() =>
        t.mutation(notes.insertThenFail, {}).then(
          () => "committed",
          (error: Error) => error.message,
        ),
      );
      expect(failed).toContain("The host mutation failed.");
      expect(yield* contents(t)).toEqual([[], []]);
    }),
  );

  it.effect(
    "a nested mutation that fails drops its own writes and keeps its caller's",
    () =>
      Effect.gen(function* () {
        const t = world();
        yield* Effect.promise(() =>
          t.mutation(notes.keepAfterNestedFailure, {}),
        );
        expect(yield* contents(t)).toEqual([["kept"], []]);
      }),
  );

  it.effect(
    "a caller's write issued beside its nested mutation survives that mutation's failure",
    () =>
      Effect.gen(function* () {
        const t = world();
        yield* Effect.promise(() =>
          t.mutation(notes.writeBesideNestedFailure, {}),
        );
        expect(yield* contents(t)).toEqual([["beside"], []]);
      }),
  );
});

// Convex runs a query's or mutation's async syscalls one at a time in the
// order they were made, a nested call included, so these cases issue their
// syscalls together with `Promise.all` and need no latch.
describe("syscall order", () => {
  const note = (t: ReturnType<typeof world>) =>
    Effect.promise((): Promise<string> =>
      t.run((ctx: any) => ctx.db.insert("notes", { text: "initial" })),
    );
  const textOf = (t: ReturnType<typeof world>, id: string) =>
    Effect.promise(() => t.run((ctx: any) => ctx.db.get(id))).pipe(
      Effect.map((doc: any) => doc.text),
    );

  it.effect(
    "a caller's write issued after its nested mutation runs after it",
    () =>
      Effect.gen(function* () {
        const t = world();
        const id = yield* note(t);
        yield* Effect.promise(() =>
          t.mutation(notes.renameAfterNested, { id }),
        );
        expect(yield* textOf(t, id)).toBe("parent");
      }),
  );

  it.effect(
    "a nested call sees its caller's write issued before it, and a nested mutation can replace it",
    () =>
      Effect.gen(function* () {
        const t = world();
        const id = yield* note(t);
        const seen = yield* Effect.promise(() =>
          t.mutation(notes.renameBeforeNested, { id }),
        );
        expect({ seen, text: yield* textOf(t, id) }).toEqual({
          seen: "parent",
          text: "child",
        });
      }),
  );

  it.effect("a query issued after a write reads that write", () =>
    Effect.gen(function* () {
      const t = world();
      expect(
        yield* Effect.promise(() => t.mutation(notes.insertThenList, {})),
      ).toEqual(["queued"]);
    }),
  );
});

describe("identity", () => {
  const signedIn = (t: ReturnType<typeof world>) =>
    t.withIdentity({ subject: "host-user" });

  it.effect("a host function and its nested host calls see the caller", () =>
    Effect.gen(function* () {
      const t = signedIn(world());
      expect(yield* Effect.promise(() => t.query(notes.whoami, {}))).toBe(
        "host-user",
      );
      expect(
        yield* Effect.promise(() => t.action(notes.whoamiThroughQuery, {})),
      ).toBe("host-user");
    }),
  );

  it.effect(
    "a component action's own nested query sees no identity from the host's caller",
    () =>
      Effect.gen(function* () {
        const t = signedIn(world());
        expect(
          yield* Effect.promise(() => t.action(notes.componentWhoami, {})),
        ).toBeNull();
      }),
  );

  it.effect(
    "a component function the test calls directly sees no identity",
    () =>
      Effect.gen(function* () {
        const t = signedIn(world());
        expect(
          yield* Effect.promise(() => t.query(store.rows.whoami, {})),
        ).toBeNull();
      }),
  );
});

describe("record validators", () => {
  const scores = v.record(v.string(), v.number());
  const recordSchema = defineSchema({
    boards: defineTable({ scores }),
  });
  const boards = {
    take: makeFunctionReference<"mutation", { scores: unknown }>("boards:take"),
    give: makeFunctionReference<"query", { scores: unknown }>("boards:give"),
    keyed: makeFunctionReference<"mutation", { scores: unknown }>(
      "boards:keyed",
    ),
    future: makeFunctionReference<"query">("boards:future"),
  };
  const recordWorld = () =>
    convexTest(recordSchema, {
      "_generated/server.ts": () => Promise.resolve({}),
      "boards.ts": () =>
        Promise.resolve({
          take: mutationGeneric({ args: { scores }, handler: () => null }),
          give: queryGeneric({
            args: { scores: v.any() },
            returns: scores,
            handler: (_ctx, args) => args.scores,
          }),
          keyed: mutationGeneric({
            args: {
              scores: v.record(
                v.union(v.literal("home"), v.literal("away")),
                v.number(),
              ),
            },
            handler: () => null,
          }),
          // A validator kind this kernel does not know, as a newer Convex
          // could export.
          future: {
            isQuery: true,
            isPublic: true,
            _handler: () => null,
            exportArgs: () =>
              JSON.stringify({
                type: "object",
                value: { x: { fieldType: { type: "future" }, optional: true } },
              }),
            exportReturns: () => "null",
          },
        }),
    });
  const outcome = (run: () => Promise<unknown>) =>
    Effect.promise(() =>
      run().then(
        () => "accepted",
        (error: Error) => error.message,
      ),
    );

  it.effect("arguments are checked against a record's values", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      expect(
        yield* outcome(() => t.mutation(boards.take, { scores: { a: 1 } })),
      ).toBe("accepted");
      for (const wrong of [{ a: "wrong" }, 42, null]) {
        expect(
          yield* outcome(() => t.mutation(boards.take, { scores: wrong })),
        ).toContain("Validator error");
      }
    }),
  );

  it.effect("arguments are checked against a record's keys", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      expect(
        yield* outcome(() => t.mutation(boards.keyed, { scores: { home: 1 } })),
      ).toBe("accepted");
      expect(
        yield* outcome(() =>
          t.mutation(boards.keyed, { scores: { elsewhere: 1 } }),
        ),
      ).toContain("Validator error");
    }),
  );

  it.effect("a return value is checked against a record", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      expect(
        yield* outcome(() => t.query(boards.give, { scores: { a: 1 } })),
      ).toBe("accepted");
      expect(
        yield* outcome(() => t.query(boards.give, { scores: { a: "wrong" } })),
      ).toContain("Return value validation failed");
    }),
  );

  it.effect("a written row is checked against a record field", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      expect(
        yield* outcome(() =>
          t.run((ctx: any) => ctx.db.insert("boards", { scores: { a: 1 } })),
        ),
      ).toBe("accepted");
      expect(
        yield* outcome(() =>
          t.run((ctx: any) =>
            ctx.db.insert("boards", { scores: { a: "wrong" } }),
          ),
        ),
      ).toContain("Validator error");
    }),
  );

  it.effect("a validator kind the kernel does not know is refused", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      expect(yield* outcome(() => t.query(boards.future, { x: 1 }))).toContain(
        "cannot check a validator of type `future`",
      );
    }),
  );
});

describe("cross-component atomicity", () => {
  it.effect(
    "a host mutation publishes its component's writes only when it commits",
    () =>
      Effect.gen(function* () {
        const t = world();
        const inside = latch();
        const gate = latch();
        reached = inside.release;
        hold = gate.promise;
        const pending = t.mutation(notes.writeBoth, { fail: false });
        yield* Effect.promise(() => inside.promise);
        expect(yield* contents(t)).toEqual([[], []]);
        gate.release();
        yield* Effect.promise(() => pending);
        expect(yield* contents(t)).toEqual([["host"], ["component"]]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reached = () => {};
            hold = Promise.resolve();
          }),
        ),
      ),
  );

  it.effect(
    "a host mutation that fails after its component call returned publishes neither",
    () =>
      Effect.gen(function* () {
        const t = world();
        const failed = yield* Effect.promise(() =>
          t.mutation(notes.writeBoth, { fail: true }).then(
            () => "committed",
            (error: Error) => error.message,
          ),
        );
        expect(failed).toContain("The host failed after its component.");
        expect(yield* contents(t)).toEqual([[], []]);
      }),
  );
});

describe("module loading", () => {
  it.effect(
    "every function module of every component loads before the first function runs",
    () =>
      Effect.gen(function* () {
        const loads: Array<string> = [];
        const recorded = (name: string, module: object) => () => {
          loads.push(name);
          return Promise.resolve(module);
        };
        const t = convexTest(hostSchema, {
          "_generated/server.ts": recorded("_generated/server", {}),
          "first.ts": recorded("first", {
            run: queryGeneric({
              args: {},
              handler: () => {
                loads.push("handler");
                return null;
              },
            }),
          }),
          "second.ts": recorded("second", {}),
          "schema.ts": recorded("schema", {}),
        });
        t.registerComponent("store", storeSchema, {
          "_generated/server.ts": recorded("store/_generated/server", {}),
          "rows.ts": recorded("store/rows", {}),
          "nested/inner.ts": recorded("store/nested/inner", {}),
        });
        yield* Effect.promise(() =>
          t.query(makeFunctionReference<"query">("first:run"), {}),
        );
        expect(loads.slice(0, -1).toSorted()).toEqual([
          "first",
          "second",
          "store/nested/inner",
          "store/rows",
        ]);
        expect(loads.at(-1)).toBe("handler");
      }),
  );

  // Convex's bundler deploys none of these, so the binary never loads them.
  // The official Workflow kit registers its own `*.test.ts` files, which fail
  // when imported inside a running test.
  it.effect("a module the Convex bundler skips never loads", () =>
    Effect.gen(function* () {
      const loads: Array<string> = [];
      const recorded = (name: string) => () => {
        loads.push(name);
        return Promise.resolve({});
      };
      const t = convexTest(hostSchema, {
        "_generated/server.ts": recorded("_generated/server"),
        "schema.ts": recorded("schema"),
        "convex.config.ts": recorded("convex.config"),
        "notes.test.ts": recorded("notes.test"),
        ".hidden.ts": recorded(".hidden"),
        "child/convex.config.ts": recorded("child/convex.config"),
        "child/rows.ts": recorded("child/rows"),
        "notes.ts": hostModules["notes.ts"],
      });
      yield* Effect.promise(() => t.query(notes.list, {}));
      expect(loads).toEqual([]);
    }),
  );

  // The official Workflow runner hides `process` while a handler runs. A
  // module loaded on first use inside that handler then fails at load.
  it.effect(
    "a handler that hides a global calls into a module that reads it at load",
    () =>
      Effect.gen(function* () {
        const probe = globalThis as {
          kernelProbe?: { readonly env: string } | undefined;
        };
        probe.kernelProbe = { env: "loaded" };
        const t = convexTest(hostSchema, {
          "_generated/server.ts": () => Promise.resolve({}),
          "reader.ts": () => {
            const env = probe.kernelProbe!.env;
            return Promise.resolve({
              read: queryGeneric({ args: {}, handler: () => env }),
            });
          },
          "runner.ts": () =>
            Promise.resolve({
              run: mutationGeneric({
                args: {},
                handler: (ctx) => {
                  const saved = probe.kernelProbe;
                  delete probe.kernelProbe;
                  return ctx
                    .runQuery(makeFunctionReference<"query">("reader:read"), {})
                    .finally(() => {
                      probe.kernelProbe = saved;
                    });
                },
              }),
            }),
        });
        expect(
          yield* Effect.promise(() =>
            t.mutation(makeFunctionReference<"mutation">("runner:run"), {}),
          ),
        ).toBe("loaded");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            delete (globalThis as { kernelProbe?: unknown }).kernelProbe;
          }),
        ),
      ),
  );

  // The real kit at Frame's pin, through its own `register`, which also mounts
  // Workpool and Batch Worker. Running workflows is row 5's.
  it.effect(
    "the official Workflow kit's modules load at open with no preload",
    () =>
      Effect.gen(function* () {
        const loads: Array<string> = [];
        const registered: Array<string> = [];
        const t = convexTest(hostSchema, {
          "_generated/server.ts": () => Promise.resolve({}),
          "first.ts": () =>
            Promise.resolve({
              run: queryGeneric({
                args: {},
                handler: () => {
                  loads.push("handler");
                  return null;
                },
              }),
            }),
        });
        const recording = {
          ...t,
          registerComponent: (
            name: string,
            schema: any,
            modules: Record<string, () => Promise<unknown>>,
          ) =>
            t.registerComponent(
              name,
              schema,
              Object.fromEntries(
                Object.entries(modules).map(([path, load]) => {
                  registered.push(`${name} ${path}`);
                  return [
                    path,
                    () => {
                      loads.push(`${name} ${path}`);
                      return load();
                    },
                  ];
                }),
              ),
            ),
        };
        registerWorkflow(recording as any, "workflow");
        yield* Effect.promise(() =>
          t.query(makeFunctionReference<"query">("first:run"), {}),
        );
        const deployable = registered.filter(
          (module) =>
            !/\/_generated\/|\/(schema|convex\.config)\.ts$|\.test\.ts$/.test(
              module,
            ),
        );
        expect(deployable).toHaveLength(27);
        expect(loads.at(-1)).toBe("handler");
        expect(loads.slice(0, -1).toSorted()).toEqual(deployable.toSorted());
        expect(
          new Set(deployable.map((module) => module.split(" ")[0])),
        ).toEqual(
          new Set([
            "workflow",
            "workflow/workpool",
            "workflow/workpool/batchWorker",
          ]),
        );
      }),
  );

  it.effect("a component registered after the first call is refused", () =>
    Effect.gen(function* () {
      const t = world();
      yield* Effect.promise(() => t.query(notes.list, {}));
      expect(() =>
        t.registerComponent("late", storeSchema, storeModules),
      ).toThrow(expect.objectContaining({ _tag: "RegisteredAfterOpen" }));
    }),
  );
});

const occSchema = defineSchema({
  counters: defineTable({ n: v.number() }),
  keys: defineTable({ key: v.string() }).index("by_key", ["key"]),
  seen: defineTable({ what: v.string() }),
  stamps: defineTable({ label: v.string(), at: v.commitTs() }),
});

const occModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "occ.ts": () =>
    Promise.resolve({
      create: mutationGeneric({
        args: {},
        handler: (ctx) => ctx.db.insert("counters", { n: 0 }),
      }),
      bump: mutationGeneric({
        args: { id: v.id("counters") },
        handler: (ctx, { id }) =>
          ctx.db
            .get(id)
            .then((counter) => ctx.db.patch(id, { n: counter!.n + 1 }))
            .then(() => null),
      }),
      counter: queryGeneric({
        args: { id: v.id("counters") },
        handler: (ctx, { id }) => ctx.db.get(id).then((counter) => counter!.n),
      }),
      add: mutationGeneric({
        args: { key: v.string() },
        handler: (ctx, { key }) => ctx.db.insert("keys", { key }),
      }),
      lookup: mutationGeneric({
        args: { id: v.id("keys") },
        handler: (ctx, { id }) =>
          ctx.db
            .get(id)
            .then((row) =>
              ctx.db.insert("seen", {
                what: row === null ? "absent" : "present",
              }),
            )
            .then(() => null),
      }),
      head: mutationGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("keys")
            .withIndex("by_key")
            .first()
            .then((first) =>
              ctx.db.insert("seen", { what: first?.key ?? "none" }),
            )
            .then(() => null),
      }),
      claim: mutationGeneric({
        args: { key: v.string() },
        handler: (ctx, { key }) =>
          ctx.db
            .query("keys")
            .withIndex("by_key", (q) => q.eq("key", key))
            .unique()
            .then((row) =>
              ctx.db.insert("seen", {
                what: `${row === null ? "free" : "taken"} ${key}`,
              }),
            )
            .then(() => null),
      }),
      seen: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("seen")
            .collect()
            .then((rows) => rows.map((row) => row.what)),
      }),
      stamp: mutationGeneric({
        args: { label: v.string() },
        handler: (ctx, { label }) =>
          ctx.db
            .insert("stamps", { label, at: ctx.db.vars.commitTs })
            .then(() => null),
      }),
      throughQuery: mutationGeneric({
        args: { id: v.id("counters") },
        handler: (ctx, { id }) =>
          ctx
            .runQuery(occ.counter, { id })
            .then((n) => ctx.db.insert("seen", { what: `read ${n}` }))
            .then(() => null),
      }),
      readThenFail: mutationGeneric({
        args: { id: v.id("counters") },
        handler: (ctx, { id }) =>
          ctx.db.get(id).then(() => {
            throw new Error("The nested mutation failed after its read.");
          }),
      }),
      throughFailure: mutationGeneric({
        args: { id: v.id("counters") },
        handler: (ctx, { id }) =>
          ctx
            .runMutation(occ.readThenFail, { id })
            .catch(() => null)
            .then(() => ctx.db.insert("seen", { what: "after failure" }))
            .then(() => null),
      }),
      stamps: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("stamps")
            .collect()
            .then((rows) => rows.map(({ label, at }) => ({ label, at }))),
      }),
      remove: mutationGeneric({
        args: { id: v.id("keys") },
        handler: (ctx, { id }) => ctx.db.delete(id).then(() => null),
      }),
      writeNothing: mutationGeneric({
        args: {},
        handler: (ctx) => Promise.resolve(ctx.db.vars.commitTs),
      }),
      keyPage: queryGeneric({
        args: { numItems: v.number() },
        handler: (ctx, { numItems }) =>
          ctx.db
            .query("keys")
            .withIndex("by_key")
            .paginate({ cursor: null, numItems })
            .then(({ continueCursor }) => continueCursor),
      }),
      notePage: mutationGeneric({
        args: {
          cursor: v.union(v.string(), v.null()),
          endCursor: v.optional(v.string()),
        },
        handler: (ctx, { cursor, endCursor }) =>
          ctx.db
            .query("keys")
            .withIndex("by_key")
            .paginate({
              cursor,
              numItems: 10,
              ...(endCursor === undefined ? {} : { endCursor }),
            })
            .then(({ page }) =>
              ctx.db.insert("seen", {
                what: `page ${page.map((row) => row.key).join(",")}`,
              }),
            )
            .then(() => null),
      }),
    }),
};

const occ = {
  create: makeFunctionReference<"mutation", {}, GenericId<"counters">>(
    "occ:create",
  ),
  bump: makeFunctionReference<"mutation", { id: GenericId<"counters"> }>(
    "occ:bump",
  ),
  counter: makeFunctionReference<
    "query",
    { id: GenericId<"counters"> },
    number
  >("occ:counter"),
  add: makeFunctionReference<"mutation", { key: string }, GenericId<"keys">>(
    "occ:add",
  ),
  lookup: makeFunctionReference<"mutation", { id: GenericId<"keys"> }>(
    "occ:lookup",
  ),
  head: makeFunctionReference<"mutation">("occ:head"),
  claim: makeFunctionReference<"mutation", { key: string }>("occ:claim"),
  seen: makeFunctionReference<"query", {}, Array<string>>("occ:seen"),
  stamp: makeFunctionReference<"mutation", { label: string }>("occ:stamp"),
  throughQuery: makeFunctionReference<
    "mutation",
    { id: GenericId<"counters"> }
  >("occ:throughQuery"),
  readThenFail: makeFunctionReference<
    "mutation",
    { id: GenericId<"counters"> }
  >("occ:readThenFail"),
  throughFailure: makeFunctionReference<
    "mutation",
    { id: GenericId<"counters"> }
  >("occ:throughFailure"),
  stamps: makeFunctionReference<
    "query",
    {},
    Array<{ label: string; at: bigint }>
  >("occ:stamps"),
  remove: makeFunctionReference<"mutation", { id: GenericId<"keys"> }>(
    "occ:remove",
  ),
  writeNothing: makeFunctionReference<"mutation", {}, bigint>(
    "occ:writeNothing",
  ),
  keyPage: makeFunctionReference<"query", { numItems: number }, string>(
    "occ:keyPage",
  ),
  notePage: makeFunctionReference<
    "mutation",
    { cursor: string | null; endCursor?: string }
  >("occ:notePage"),
};

const conflicted = (applied: Execution.KernelApply) => {
  assert(applied.kind === "conflict");
  return applied.next;
};

const occWorld = (runtime?: {
  readonly now: () => number;
  readonly commitTs: (version: number) => bigint;
}): KernelControls =>
  convexTest({
    schema: occSchema,
    modules: occModules,
    ...(runtime === undefined ? {} : { runtime }),
  });

const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

describe("read sets", () => {
  it.effect(
    "a lost update conflicts, and its next attempt reads the published counter",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const id = yield* call(() => t.mutation(occ.create, {}));
        const first = yield* call(() => t.prepare(occ.bump, { id }));
        const second = yield* call(() => t.prepare(occ.bump, { id }));
        const applied = yield* call(() => t.apply(first.id));
        const next = conflicted(yield* call(() => t.apply(second.id)));
        const retried = yield* call(() => t.apply(next.id));
        expect([applied.kind, next.number, retried.kind]).toEqual([
          "applied",
          2,
          "applied",
        ]);
        expect(yield* call(() => t.query(occ.counter, { id }))).toBe(2);
      }),
  );

  it.effect(
    "concurrent mutations each publish once, because a conflicting attempt runs again",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const id = yield* call(() => t.mutation(occ.create, {}));
        yield* call(() =>
          Promise.all([1, 2, 3].map(() => t.mutation(occ.bump, { id }))),
        );
        expect(yield* call(() => t.query(occ.counter, { id }))).toBe(3);
      }),
  );

  it.effect(
    "a read of a missing document conflicts once a commit publishes it",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const added = yield* call(() => t.prepare(occ.add, { key: "x" }));
        const { outcome } = added;
        assert(outcome._tag === "returned");
        const lookup = yield* call(() =>
          t.prepare(occ.lookup, { id: outcome.value }),
        );
        yield* call(() => t.apply(added.id));
        const next = conflicted(yield* call(() => t.apply(lookup.id)));
        yield* call(() => t.apply(next.id));
        expect(yield* call(() => t.query(occ.seen, {}))).toEqual(["present"]);
      }),
  );

  it.effect(
    "`.first()` reads only the prefix it examined, so a write past it leaves the attempt valid and a write inside it conflicts",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        yield* call(() => t.mutation(occ.add, { key: "1" }));
        yield* call(() => t.mutation(occ.add, { key: "3" }));
        const past = yield* call(() => t.prepare(occ.head, {}));
        yield* call(() => t.mutation(occ.add, { key: "2" }));
        const valid = yield* call(() => t.apply(past.id));
        const inside = yield* call(() => t.prepare(occ.head, {}));
        yield* call(() => t.mutation(occ.add, { key: "0" }));
        const next = conflicted(yield* call(() => t.apply(inside.id)));
        yield* call(() => t.apply(next.id));
        expect(valid.kind).toBe("applied");
        expect(yield* call(() => t.query(occ.seen, {}))).toEqual(["1", "0"]);
      }),
  );

  it.effect(
    "an empty index range conflicts with an insert into it, and not with an insert beside it",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const beside = yield* call(() => t.prepare(occ.claim, { key: "x" }));
        yield* call(() => t.mutation(occ.add, { key: "y" }));
        const valid = yield* call(() => t.apply(beside.id));
        const phantom = yield* call(() => t.prepare(occ.claim, { key: "x" }));
        yield* call(() => t.mutation(occ.add, { key: "x" }));
        const next = conflicted(yield* call(() => t.apply(phantom.id)));
        yield* call(() => t.apply(next.id));
        expect(valid.kind).toBe("applied");
        expect(yield* call(() => t.query(occ.seen, {}))).toEqual([
          "free x",
          "taken x",
        ]);
      }),
  );

  it.effect(
    "a page from the terminal cursor reads nothing, so a write to its table leaves the attempt valid while a first page conflicts",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        yield* call(() => t.mutation(occ.add, { key: "1" }));
        const cursor = yield* call(() =>
          t.query(occ.keyPage, { numItems: 10 }),
        );
        const terminal = yield* call(() => t.prepare(occ.notePage, { cursor }));
        const first = yield* call(() =>
          t.prepare(occ.notePage, { cursor: null }),
        );
        yield* call(() => t.mutation(occ.add, { key: "2" }));
        const valid = yield* call(() => t.apply(terminal.id));
        const next = conflicted(yield* call(() => t.apply(first.id)));
        yield* call(() => t.apply(next.id));
        expect([cursor, valid.kind]).toEqual(["_end_cursor", "applied"]);
        expect(yield* call(() => t.query(occ.seen, {}))).toEqual([
          "page ",
          "page 1,2",
        ]);
      }),
  );

  it.effect(
    "a page bounded by an end cursor reads only up to it, so a write past it leaves the attempt valid and a write inside it conflicts",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        yield* call(() => t.mutation(occ.add, { key: "1" }));
        const three = yield* call(() => t.mutation(occ.add, { key: "3" }));
        const five = yield* call(() => t.mutation(occ.add, { key: "5" }));
        const endCursor = yield* call(() =>
          t.query(occ.keyPage, { numItems: 2 }),
        );
        yield* call(() => t.mutation(occ.remove, { id: three }));
        yield* call(() => t.mutation(occ.remove, { id: five }));
        const past = yield* call(() =>
          t.prepare(occ.notePage, { cursor: null, endCursor }),
        );
        yield* call(() => t.mutation(occ.add, { key: "4" }));
        const valid = yield* call(() => t.apply(past.id));
        const inside = yield* call(() =>
          t.prepare(occ.notePage, { cursor: null, endCursor }),
        );
        yield* call(() => t.mutation(occ.add, { key: "2" }));
        const next = conflicted(yield* call(() => t.apply(inside.id)));
        yield* call(() => t.apply(next.id));
        expect(valid.kind).toBe("applied");
        expect(yield* call(() => t.query(occ.seen, {}))).toEqual([
          "page 1",
          "page 1,2",
        ]);
      }),
  );

  it.effect(
    "a mutation whose every attempt conflicts is exhausted on attempt 5 and publishes nothing",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const id = yield* call(() => t.mutation(occ.create, {}));
        let attempt = yield* call(() => t.prepare(occ.bump, { id }));
        const numbers: Array<number> = [];
        for (const _ of [2, 3, 4, 5]) {
          yield* call(() => t.mutation(occ.bump, { id }));
          attempt = conflicted(yield* call(() => t.apply(attempt.id)));
          numbers.push(attempt.number);
        }
        yield* call(() => t.mutation(occ.bump, { id }));
        const exhausted = yield* call(() => t.apply(attempt.id));
        expect(numbers).toEqual([2, 3, 4, 5]);
        expect(exhausted).toMatchObject({
          kind: "exhausted",
          error: { _tag: "OptimisticConcurrencyControlFailure" },
        });
        expect(yield* call(() => t.query(occ.counter, { id }))).toBe(5);
        expect(t.held()).toEqual([]);
      }),
  );
});

describe("nested reads", () => {
  it.effect(
    "a nested query's reads join its caller's, so a commit to what it read conflicts the caller",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const id = yield* call(() => t.mutation(occ.create, {}));
        const held = yield* call(() => t.prepare(occ.throughQuery, { id }));
        yield* call(() => t.mutation(occ.bump, { id }));
        const next = conflicted(yield* call(() => t.apply(held.id)));
        yield* call(() => t.apply(next.id));
        expect(yield* call(() => t.query(occ.seen, {}))).toEqual(["read 1"]);
      }),
  );

  it.effect(
    "a nested mutation that fails keeps its reads, so a commit to what it read conflicts the caller",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const id = yield* call(() => t.mutation(occ.create, {}));
        const held = yield* call(() => t.prepare(occ.throughFailure, { id }));
        yield* call(() => t.mutation(occ.bump, { id }));
        const next = conflicted(yield* call(() => t.apply(held.id)));
        yield* call(() => t.apply(next.id));
        expect(yield* call(() => t.query(occ.seen, {}))).toEqual([
          "after failure",
        ]);
      }),
  );
});

describe("commit timestamps", () => {
  it.effect(
    "a commit takes the runtime's timestamp for its version, and the rows it stamps read it back",
    () =>
      Effect.gen(function* () {
        const t = occWorld({
          now: () => 1_000,
          commitTs: (version) => 5_000n + BigInt(version),
        });
        const a = yield* call(() => t.prepare(occ.stamp, { label: "a" }));
        const b = yield* call(() => t.prepare(occ.stamp, { label: "b" }));
        const c = yield* call(() => t.prepare(occ.stamp, { label: "c" }));
        const applied: Array<{ version: number; commitTs: bigint }> = [];
        for (const held of [c, a, b]) {
          const result = yield* call(() => t.apply(held.id));
          assert(result.kind === "applied");
          applied.push({ version: result.version, commitTs: result.commitTs });
        }
        expect(applied).toEqual([
          { version: 1, commitTs: 5_001n },
          { version: 2, commitTs: 5_002n },
          { version: 3, commitTs: 5_003n },
        ]);
        expect(yield* call(() => t.query(occ.stamps, {}))).toEqual([
          { label: "a", at: 5_002n },
          { label: "b", at: 5_003n },
          { label: "c", at: 5_001n },
        ]);
      }),
  );

  it.effect(
    "commits on a wall clock that stands still never share a timestamp",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000);
        const t = occWorld();
        for (const label of ["first", "second", "third"]) {
          yield* call(() => t.mutation(occ.stamp, { label }));
        }
        expect(
          (yield* call(() => t.query(occ.stamps, {}))).map(
            (stamp: { readonly at: bigint }) => stamp.at,
          ),
        ).toEqual([1_000_000_000n, 1_000_000_001n, 1_000_000_002n]);
      }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers()))),
  );

  it.effect(
    "a mutation that writes nothing answers its snapshot's timestamp and leaves the next commit the time it commits at",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000);
        const t = occWorld();
        yield* call(() => t.mutation(occ.stamp, { label: "first" }));
        vi.setSystemTime(1_500);
        const nothing = yield* call(() => t.mutation(occ.writeNothing, {}));
        vi.setSystemTime(2_000);
        yield* call(() => t.mutation(occ.stamp, { label: "later" }));
        expect(yield* call(() => t.query(occ.stamps, {}))).toEqual([
          { label: "first", at: 1_000_000_000n },
          { label: "later", at: 2_000_000_000n },
        ]);
        expect(nothing).toBe(1_000_000_000n);
      }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers()))),
  );

  it.effect(
    "a mutation that writes nothing asks the runtime for no timestamp",
    () =>
      Effect.gen(function* () {
        const asked: Array<number> = [];
        const t = occWorld({
          now: () => 1_000,
          commitTs: (version) => {
            asked.push(version);
            return 5_000n + BigInt(version);
          },
        });
        yield* call(() => t.mutation(occ.stamp, { label: "a" }));
        const held = yield* call(() => t.prepare(occ.writeNothing, {}));
        const applied = yield* call(() => t.apply(held.id));
        yield* call(() => t.mutation(occ.stamp, { label: "b" }));
        expect(asked).toEqual([1, 2]);
        expect(applied).toMatchObject({
          kind: "applied",
          version: 1,
          commitTs: 5_001n,
          result: 5_001n,
        });
      }),
  );

  it.effect("a runtime that repeats a commit timestamp is refused", () =>
    Effect.gen(function* () {
      const t = occWorld({ now: () => 1_000, commitTs: () => 7n });
      yield* call(() => t.mutation(occ.stamp, { label: "first" }));
      const refused = yield* call(() =>
        t.mutation(occ.stamp, { label: "second" }).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(refused).toMatchObject({ _tag: "CommitTsNotIncreasing" });
      expect(yield* call(() => t.query(occ.stamps, {}))).toEqual([
        { label: "first", at: 7n },
      ]);
    }),
  );

  it("two processes replaying one history print the same bytes", () => {
    const loader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;
    const script = fileURLToPath(
      new URL("fixtures/kernelReplay.ts", import.meta.url),
    );
    const replay = () =>
      spawnSync(process.execPath, ["--import", loader, script], {
        encoding: "utf8",
      });
    const [one, two] = [replay(), replay()];
    expect([one.status, one.stderr, two.status, two.stderr]).toEqual([
      0,
      "",
      0,
      "",
    ]);
    expect(one.stdout).toBe(two.stdout);
    const { steps, state } = jsonToConvex(
      JSON.parse(one.stdout),
    ) as unknown as {
      steps: ReadonlyArray<unknown>;
      state: { stamps: ReadonlyArray<{ at: bigint }> };
    };
    const at = (version: bigint) =>
      1_767_225_600_000_000_000n + version * 1_000n;
    expect(steps).toEqual([
      { kind: "applied", version: 2, commitTs: at(2n) },
      { kind: "conflict", next: 2 },
      { kind: "applied", version: 3, commitTs: at(3n) },
    ]);
    expect(state.stamps.map((stamp) => stamp.at)).toEqual([at(4n), at(5n)]);
  }, 60_000);
});

class Mail extends Context.Service<Mail, { readonly answer: string }>()(
  "@confect/test/test/Kernel.test/Mail",
) {}

const mail = Effect.serviceOption(Mail).pipe(
  Effect.map(Option.match({ onNone: () => null, onSome: (m) => m.answer })),
);

const register = (
  functionSpec: FunctionSpec.AnyWithProps,
  handler: Handler.Any,
) => {
  const item = FunctionRegistryItem.make({
    functionSpec,
    groupMiddlewareAttachments: [],
    handler,
  });
  assert(item._tag === "Confect");
  return RegisteredConvexFunction.make(DatabaseSchema.make({}), item);
};

// Set by each lifetime test before it calls `detached`.
let gate = Deferred.makeUnsafe<void>();
let exited = Deferred.makeUnsafe<Exit.Exit<void>>();
const order: Array<string> = [];
const attempts: Array<number | null> = [];
// Runs inside `movingAction`, between its two readings of the time.
let duringAction = () => {};

const life = {
  bed: makeFunctionReference<"mutation", {}, GenericId<"beds">>("life:bed"),
  room: makeFunctionReference<"query", { id: GenericId<"beds"> }, string>(
    "life:room",
  ),
  detached: makeFunctionReference<
    "mutation",
    { id: GenericId<"beds">; held: boolean }
  >("life:detached"),
  nestedDetached: makeFunctionReference<
    "mutation",
    { id: GenericId<"beds">; held: boolean }
  >("life:nestedDetached"),
  counter: makeFunctionReference<"mutation", {}, GenericId<"counters">>(
    "life:counter",
  ),
  bump: makeFunctionReference<"mutation", { id: GenericId<"counters"> }>(
    "life:bump",
  ),
  numbered: makeFunctionReference<"mutation", { id: GenericId<"counters"> }>(
    "life:numbered",
  ),
  outer: makeFunctionReference<
    "action",
    {},
    { outer: string | null; nested: string | null }
  >("life:outer"),
  inner: makeFunctionReference<"action", {}, string | null>("life:inner"),
  pinnedOuter: makeFunctionReference<
    "action",
    {},
    { outer: Pinned; nested: Pinned; after: Pinned }
  >("life:pinnedOuter"),
  pinnedInner: makeFunctionReference<"action", {}, Pinned>("life:pinnedInner"),
  movingAction: makeFunctionReference<
    "action",
    {},
    { before: number; after: number; called: number }
  >("life:movingAction"),
  pinnedQuery: makeFunctionReference<"query", {}, Pinned>("life:pinnedQuery"),
  stamped: makeFunctionReference<
    "mutation",
    {},
    { now: number; created: number }
  >("life:stamped"),
};

interface Pinned {
  readonly now: number;
  readonly random: number;
}

const PinnedSchema = Schema.Struct({
  now: Schema.Finite,
  random: Schema.Finite,
});

const pinned = Effect.sync(
  // oxlint-disable-next-line effecttsgo/global-date-in-effect, effecttsgo/global-random-in-effect -- The handler reads the ambient Date and Math.random the bridge pins.
  (): Pinned => ({ now: Date.now(), random: Math.random() }),
);

const bumpCounter = (ctx: GenericMutationCtx<GenericDataModel>, id: string) =>
  Effect.gen(function* () {
    const counter = id as GenericId<"counters">;
    const { n } = (yield* Effect.promise(() =>
      ctx.db.get(counter),
    )) as unknown as { n: number };
    yield* Effect.promise(() => ctx.db.patch(counter, { n: n + 1 }));
  });

const lifeModule = {
  bed: mutationGeneric({
    args: {},
    handler: (ctx) => ctx.db.insert("beds", { room: "1" }),
  }),
  room: queryGeneric({
    args: { id: v.id("beds") },
    handler: (ctx, { id }) => ctx.db.get(id).then((bed) => bed!.room),
  }),
  counter: mutationGeneric({
    args: {},
    handler: (ctx) => ctx.db.insert("counters", { n: 0 }),
  }),
  bump: mutationGeneric({
    args: { id: v.id("counters") },
    handler: (ctx, { id }) =>
      ctx.db
        .get(id)
        .then((counter) => ctx.db.patch(id, { n: counter!.n + 1 }))
        .then(() => null),
  }),
  // Frame's authz latch fixture `detached` without the door's seal. Its five
  // reads stand where the door's writer reads the caller's reach before it
  // writes, so the late write reaches the database after the handler settled.
  detached: register(
    FunctionSpec.publicMutation({
      name: "detached",
      args: () => ({ id: Schema.String, held: Schema.Boolean }),
      returns: () => Schema.Null,
    }),
    ({ id, held }: { readonly id: string; readonly held: boolean }) =>
      Effect.gen(function* () {
        const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
        const bed = id as GenericId<"beds">;
        yield* Effect.promise(() => ctx.db.patch(bed, { room: "moved" }));
        const late = Effect.forEach(
          [1, 2, 3, 4, 5],
          () => Effect.promise(() => ctx.db.get(bed)),
          { discard: true },
        ).pipe(
          Effect.andThen(
            Effect.promise(() => ctx.db.patch(bed, { room: "detached" })),
          ),
          Effect.andThen(
            Effect.sync(() => {
              order.push("late write");
            }),
          ),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.succeed(exited, exit)),
        );
        yield* Effect.forkDetach(
          held ? Deferred.await(gate).pipe(Effect.andThen(late)) : late,
        );
        return null;
      }).pipe(
        Effect.ensuring(Effect.sync(() => order.push("handler settled"))),
      ),
  ),
  nestedDetached: mutationGeneric({
    args: { id: v.id("beds"), held: v.boolean() },
    handler: (ctx, args) =>
      ctx.runMutation(life.detached, args).then(() => null),
  }),
  numbered: register(
    FunctionSpec.publicMutation({
      name: "numbered",
      args: () => ({ id: Schema.String }),
      returns: () => Schema.Null,
    }),
    ({ id }: { readonly id: string }) =>
      Effect.gen(function* () {
        attempts.push(Invocation.current()?.attempt ?? null);
        const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
        yield* bumpCounter(ctx, id);
        return null;
      }),
  ),
  outer: register(
    FunctionSpec.publicAction({
      name: "outer",
      args: () => ({}),
      returns: () =>
        Schema.Struct({
          outer: Schema.NullOr(Schema.String),
          nested: Schema.NullOr(Schema.String),
        }),
    }),
    () =>
      Effect.gen(function* () {
        const outer = yield* mail;
        const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
        const nested = yield* Effect.promise(() => ctx.runAction(life.inner));
        return { outer, nested };
      }),
  ),
  inner: register(
    FunctionSpec.internalAction({
      name: "inner",
      args: () => ({}),
      returns: () => Schema.NullOr(Schema.String),
    }),
    () => mail,
  ),
  pinnedOuter: register(
    FunctionSpec.publicAction({
      name: "pinnedOuter",
      args: () => ({}),
      returns: () =>
        Schema.Struct({
          outer: PinnedSchema,
          nested: PinnedSchema,
          after: PinnedSchema,
        }),
    }),
    () =>
      Effect.gen(function* () {
        const outer = yield* pinned;
        const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
        const nested = yield* Effect.promise(() =>
          ctx.runAction(life.pinnedInner),
        );
        const after = yield* pinned;
        return { outer, nested, after };
      }),
  ),
  movingAction: register(
    FunctionSpec.publicAction({
      name: "movingAction",
      args: () => ({}),
      returns: () =>
        Schema.Struct({
          before: Schema.Finite,
          after: Schema.Finite,
          called: Schema.Finite,
        }),
    }),
    () =>
      Effect.gen(function* () {
        const before = (yield* pinned).now;
        yield* Effect.sync(() => duringAction());
        const after = (yield* pinned).now;
        const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
        const { now: called } = yield* Effect.promise(() =>
          ctx.runMutation(life.stamped, {}),
        );
        return { before, after, called };
      }),
  ),
  pinnedInner: register(
    FunctionSpec.internalAction({
      name: "pinnedInner",
      args: () => ({}),
      returns: () => PinnedSchema,
    }),
    () => pinned,
  ),
  pinnedQuery: register(
    FunctionSpec.publicQuery({
      name: "pinnedQuery",
      args: () => ({}),
      returns: () => PinnedSchema,
    }),
    () => pinned,
  ),
  stamped: register(
    FunctionSpec.publicMutation({
      name: "stamped",
      args: () => ({}),
      returns: () =>
        Schema.Struct({ now: Schema.Finite, created: Schema.Finite }),
    }),
    () =>
      Effect.gen(function* () {
        const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
        const id = yield* Effect.promise(() =>
          ctx.db.insert("counters", { n: 0 }),
        );
        const doc = yield* Effect.promise(() => ctx.db.get(id));
        const { now } = yield* pinned;
        return { now, created: doc!._creationTime };
      }),
  ),
};

const lifeWorld = (runtime?: {
  readonly now: () => number;
  readonly commitTs: (version: number) => bigint;
}): KernelControls =>
  convexTest({
    schema: defineSchema({
      beds: defineTable({ room: v.string() }),
      counters: defineTable({ n: v.number() }),
    }),
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "life.ts": () => Promise.resolve(lifeModule),
    },
    ...(runtime === undefined ? {} : { runtime }),
  });

// The kernel's clock stands at 5000, apart from every invocation's start time.
const kernelAt5000 = {
  now: () => 5_000,
  commitTs: (version: number) => BigInt(version),
};

describe("lifetime", () => {
  it.effect(
    "a write a detached fiber makes after its handler settled commits with its mutation",
    () =>
      Effect.gen(function* () {
        order.length = 0;
        exited = Deferred.makeUnsafe();
        const t = lifeWorld();
        const id = yield* call(() => t.mutation(life.bed, {}));
        yield* call(() => t.mutation(life.detached, { id, held: false }));
        const exit = yield* Deferred.await(exited);
        expect({
          exit: exit._tag,
          order,
          room: yield* call(() => t.query(life.room, { id })),
        }).toEqual({
          exit: "Success",
          order: ["handler settled", "late write"],
          room: "detached",
        });
      }),
  );

  it.effect(
    "a write that reaches a mutation after it returned is refused, and the mutation's own write commits",
    () =>
      Effect.gen(function* () {
        gate = Deferred.makeUnsafe();
        exited = Deferred.makeUnsafe();
        const t = lifeWorld();
        const id = yield* call(() => t.mutation(life.bed, {}));
        yield* call(() => t.mutation(life.detached, { id, held: true }));
        yield* Deferred.succeed(gate, undefined);
        const exit = yield* Deferred.await(exited);
        expect({
          refusal: Exit.isFailure(exit)
            ? String(Cause.squash(exit.cause))
            : "none",
          room: yield* call(() => t.query(life.room, { id })),
        }).toEqual({
          refusal: expect.stringContaining(
            "reached mutation life:detached after it returned",
          ),
          room: "moved",
        });
      }),
  );

  it.effect(
    "a write a detached fiber makes after its nested mutation's handler settled commits with its caller",
    () =>
      Effect.gen(function* () {
        order.length = 0;
        exited = Deferred.makeUnsafe();
        const t = lifeWorld();
        const id = yield* call(() => t.mutation(life.bed, {}));
        yield* call(() => t.mutation(life.nestedDetached, { id, held: false }));
        const exit = yield* Deferred.await(exited);
        expect({
          exit: exit._tag,
          order,
          room: yield* call(() => t.query(life.room, { id })),
        }).toEqual({
          exit: "Success",
          order: ["handler settled", "late write"],
          room: "detached",
        });
      }),
  );

  it.effect(
    "a write that reaches a nested mutation after it returned is refused, and its own write commits with its caller",
    () =>
      Effect.gen(function* () {
        gate = Deferred.makeUnsafe();
        exited = Deferred.makeUnsafe();
        const t = lifeWorld();
        const id = yield* call(() => t.mutation(life.bed, {}));
        yield* call(() => t.mutation(life.nestedDetached, { id, held: true }));
        yield* Deferred.succeed(gate, undefined);
        const exit = yield* Deferred.await(exited);
        expect({
          refusal: Exit.isFailure(exit)
            ? String(Cause.squash(exit.cause))
            : "none",
          room: yield* call(() => t.query(life.room, { id })),
        }).toEqual({
          refusal: expect.stringContaining(
            "reached mutation life:detached after it returned",
          ),
          room: "moved",
        });
      }),
  );
});

describe("invocations", () => {
  const home: Invocation.World = {
    name: "world",
    services: Context.make(Mail, { answer: "world mail" }),
    clock: () => 2_000,
    random: () => 0.75,
  };
  const caller: Invocation.Invocation = {
    world: home,
    componentPath: "",
    attempt: 1,
    request: {
      ip: null,
      userAgent: null,
      requestId: "caller-request",
      scheduledFunctionId: null,
    },
    services: Context.make(Mail, { answer: "caller mail" }),
    startedAt: 1_000,
    random: () => 0.25,
  };

  it.effect(
    "each attempt of a held mutation starts its handler under its own attempt number",
    () =>
      Effect.gen(function* () {
        attempts.length = 0;
        const t = lifeWorld();
        const id = yield* call(() => t.mutation(life.counter, {}));
        const held = yield* call(() =>
          Invocation.bind(caller, () => t.prepare(life.numbered, { id })),
        );
        yield* call(() => t.mutation(life.bump, { id }));
        const next = conflicted(yield* call(() => t.apply(held.id)));
        yield* call(() => t.apply(next.id));
        expect(attempts).toEqual([1, 2]);
      }),
  );

  it.effect(
    "a nested action starts under a fresh invocation with its world's services",
    () =>
      Effect.gen(function* () {
        const t = lifeWorld();
        const seen = yield* call(() =>
          Invocation.bind(caller, () => t.action(life.outer, {})),
        );
        expect(seen).toEqual({ outer: "caller mail", nested: "world mail" });
      }),
  );

  it.effect(
    "a bound handler reads the kernel's clock and its invocation's stream, a nested action its world's stream, and test code the host's",
    () =>
      Effect.gen(function* () {
        const t = lifeWorld(kernelAt5000);
        const host = { Date: globalThis.Date, Math: globalThis.Math };
        const seen = yield* call(() =>
          Invocation.bind(caller, () => t.action(life.pinnedOuter, {})),
        );
        expect(seen).toEqual({
          outer: { now: 5_000, random: 0.25 },
          nested: { now: 5_000, random: 0.75 },
          after: { now: 5_000, random: 0.25 },
        });
        expect({ Date: globalThis.Date, Math: globalThis.Math }).toEqual(host);
        // oxlint-disable-next-line effecttsgo/global-date-in-effect -- Test code reads the host's clock, which no handler's pin may reach.
        expect(Date.now()).toBeGreaterThan(5_000);
      }),
  );

  it.effect(
    "a bound action reads the kernel's clock as it runs, and a mutation it calls starts at the kernel's time then, whatever its world's clock says",
    () =>
      Effect.gen(function* () {
        let now = 5_000;
        const t = lifeWorld({
          now: () => now,
          commitTs: (version) => BigInt(version),
        });
        duringAction = () => {
          now = 7_000;
        };
        const seen = yield* call(() =>
          Invocation.bind(caller, () => t.action(life.movingAction, {})),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              duringAction = () => {};
            }),
          ),
        );
        expect(seen).toEqual({ before: 5_000, after: 7_000, called: 7_000 });
      }),
  );

  it.effect(
    "a bound mutation reads the kernel's clock, not its invocation's start time, and its document's creation time follows it",
    () =>
      Effect.gen(function* () {
        const t = lifeWorld(kernelAt5000);
        const seen = yield* call(() =>
          Invocation.bind(caller, () => t.mutation(life.stamped, {})),
        );
        expect(seen).toEqual({ now: 5_000, created: 5_000 });
      }),
  );

  it.effect(
    "a bound subscription's query reads the kernel's clock and records the read, so the clock moving alone changes nothing",
    () =>
      Effect.gen(function* () {
        let now = 5_000;
        const t = lifeWorld({
          now: () => now,
          commitTs: (version) => BigInt(version),
        });
        const subscription = yield* call(() =>
          Invocation.bind(caller, () =>
            t.subscriber().subscribe(life.pinnedQuery, {}),
          ),
        );
        expect(subscription.current()).toMatchObject({
          outcome: { _tag: "returned", value: { now: 5_000, random: 0.25 } },
          time: 5_000,
        });
        now = 6_000;
        expect(
          yield* call(() => Invocation.bind(caller, () => t.reference())),
        ).toEqual([]);
      }),
  );
});
