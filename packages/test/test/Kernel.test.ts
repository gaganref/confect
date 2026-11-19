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
  createFunctionHandle,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { ConvexError, jsonToConvex, v, type GenericId } from "convex/values";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Execution from "../src/internal/Execution";
import * as Invocation from "../src/internal/Invocation";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Json from "../src/internal/Json";
import {
  payloads,
  type Caught,
  type Payload,
  type Target,
} from "../../../tools/local-backend/fixtures/plain/convex/convexErrors";
import { inlineSources, withSources } from "./fixtures/inlineSources";
import { plainSource } from "./fixtures/fixtureSources";
import {
  mixedCopiesReport,
  orders,
  reportOf,
  runFixture,
  times,
  twoCopiesReport,
} from "./fixtures/copies";

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
            .then((rows) => Arr.map(rows, (row) => row.text)),
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
            .then((rows) => Arr.map(rows, (row) => row.text)),
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
              .then((rows) => Arr.map(rows, (row) => row.text)),
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
  const t = convexTest({
    schema: hostSchema,
    modules: hostModules,
    sources: inlineSources(hostModules),
  });
  t.registerComponent("store", storeSchema, storeModules, {
    sources: inlineSources(storeModules),
  });
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
      const contentsResult = yield* contents(t);
      expect(contentsResult).toEqual([[], []]);
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
        const contentsResult = yield* contents(t);
        expect(contentsResult).toEqual([["kept"], []]);
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
        const contentsResult = yield* contents(t);
        expect(contentsResult).toEqual([["beside"], []]);
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
        const textOfResult = yield* textOf(t, id);
        expect(textOfResult).toBe("parent");
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
      const resolved = yield* Effect.promise(() =>
        t.mutation(notes.insertThenList, {}),
      );
      expect(resolved).toEqual(["queued"]);
    }),
  );
});

describe("identity", () => {
  const signedIn = (t: ReturnType<typeof world>) =>
    t.withIdentity({ subject: "host-user" });

  it.effect("a host function and its nested host calls see the caller", () =>
    Effect.gen(function* () {
      const t = signedIn(world());
      const resolved = yield* Effect.promise(() => t.query(notes.whoami, {}));
      expect(resolved).toBe("host-user");
      const resolved2 = yield* Effect.promise(() =>
        t.action(notes.whoamiThroughQuery, {}),
      );
      expect(resolved2).toBe("host-user");
    }),
  );

  it.effect(
    "a component action's own nested query sees no identity from the host's caller",
    () =>
      Effect.gen(function* () {
        const t = signedIn(world());
        const resolved = yield* Effect.promise(() =>
          t.action(notes.componentWhoami, {}),
        );
        expect(resolved).toBeNull();
      }),
  );

  it.effect(
    "a component function the test calls directly sees no identity",
    () =>
      Effect.gen(function* () {
        const t = signedIn(world());
        const resolved = yield* Effect.promise(() =>
          t.query(store.rows.whoami, {}),
        );
        expect(resolved).toBeNull();
      }),
  );
});

describe("function validators", () => {
  const callbacks = {
    target: makeFunctionReference<"query">("callbacks:target"),
    mint: makeFunctionReference<"mutation", {}, string>("callbacks:mint"),
    store: makeFunctionReference<"mutation", { handle: unknown }>(
      "callbacks:store",
    ),
  };
  const callbackWorld = () =>
    convexTest(defineSchema({}), {
      "_generated/server.ts": () => Promise.resolve({}),
      "callbacks.ts": () =>
        Promise.resolve({
          target: queryGeneric({ args: {}, handler: () => null }),
          mint: mutationGeneric({
            args: {},
            handler: () => createFunctionHandle(callbacks.target),
          }),
          store: mutationGeneric({
            args: { handle: v.function() },
            handler: () => null,
          }),
        }),
    });
  const outcome = (run: () => Promise<unknown>) =>
    Effect.promise(() =>
      run().then(
        () => "accepted",
        (error: Error) => error.message,
      ),
    );

  it.effect(
    "a function validator accepts a handle the kernel minted and refuses a string that is no handle",
    () =>
      Effect.gen(function* () {
        const t = callbackWorld();
        const handle = yield* call(() => t.mutation(callbacks.mint, {}));
        const outcomeResult = yield* outcome(() =>
          t.mutation(callbacks.store, { handle }),
        );
        expect(outcomeResult).toBe("accepted");
        const outcomeResult2 = yield* outcome(() =>
          t.mutation(callbacks.store, { handle: "callbacks:target" }),
        );
        expect(outcomeResult2).toContain("Expected a function handle");
      }),
  );

  it.effect.each([
    ["the bare prefix", "function://"],
    ["a prefix without a component separator", "function://not-a-valid-handle"],
    ["a prefix with no function path", "function://;"],
    ["a prefix with two separators", "function://;callbacks:target;extra"],
  ])("a function validator refuses %s", ([, handle]) =>
    Effect.gen(function* () {
      const t = callbackWorld();
      const outcomeResult = yield* outcome(() =>
        t.mutation(callbacks.store, { handle }),
      );
      expect(outcomeResult).toContain("Expected a function handle");
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
              Json.stringify({
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
      const outcomeResult = yield* outcome(() =>
        t.mutation(boards.take, { scores: { a: 1 } }),
      );
      expect(outcomeResult).toBe("accepted");
      for (const wrong of [{ a: "wrong" }, 42, null]) {
        const outcomeResult2 = yield* outcome(() =>
          t.mutation(boards.take, { scores: wrong }),
        );
        expect(outcomeResult2).toContain("Validator error");
      }
    }),
  );

  it.effect("arguments are checked against a record's keys", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      const outcomeResult = yield* outcome(() =>
        t.mutation(boards.keyed, { scores: { home: 1 } }),
      );
      expect(outcomeResult).toBe("accepted");
      const outcomeResult2 = yield* outcome(() =>
        t.mutation(boards.keyed, { scores: { elsewhere: 1 } }),
      );
      expect(outcomeResult2).toContain("Validator error");
    }),
  );

  it.effect("a return value is checked against a record", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      const outcomeResult = yield* outcome(() =>
        t.query(boards.give, { scores: { a: 1 } }),
      );
      expect(outcomeResult).toBe("accepted");
      const outcomeResult2 = yield* outcome(() =>
        t.query(boards.give, { scores: { a: "wrong" } }),
      );
      expect(outcomeResult2).toContain("Return value validation failed");
    }),
  );

  it.effect("a written row is checked against a record field", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      const outcomeResult = yield* outcome(() =>
        t.run((ctx: any) => ctx.db.insert("boards", { scores: { a: 1 } })),
      );
      expect(outcomeResult).toBe("accepted");
      const outcomeResult2 = yield* outcome(() =>
        t.run((ctx: any) =>
          ctx.db.insert("boards", { scores: { a: "wrong" } }),
        ),
      );
      expect(outcomeResult2).toContain("Validator error");
    }),
  );

  it.effect("a validator kind the kernel does not know is refused", () =>
    Effect.gen(function* () {
      const t = recordWorld();
      const outcomeResult = yield* outcome(() =>
        t.query(boards.future, { x: 1 }),
      );
      expect(outcomeResult).toContain(
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
        const contentsResult = yield* contents(t);
        expect(contentsResult).toEqual([[], []]);
        gate.release();
        yield* Effect.promise(() => pending);
        const contentsResult2 = yield* contents(t);
        expect(contentsResult2).toEqual([["host"], ["component"]]);
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
        const contentsResult = yield* contents(t);
        expect(contentsResult).toEqual([[], []]);
      }),
  );
});

// What a syscall made outside any kernel function, a module load included,
// fails with.
const outsideFunction =
  "A Convex syscall ran outside any function the test kernel started.";

/**
 * What a promise settled with: its value, or the message it rejected with.
 */
type Attempted = { readonly value: unknown } | { readonly error: string };

const attempted = (promise: Promise<unknown>): Promise<Attempted> =>
  promise.then(
    (value): Attempted => ({ value }),
    (error: unknown): Attempted => ({
      error: error instanceof Error ? error.message : String(error),
    }),
  );

/**
 * What calling through an action's kept context settled with: each function it
 * can start, and a scheduled call.
 */
interface KeptCalls {
  readonly runQuery: Attempted;
  readonly runMutation: Attempted;
  readonly runAction: Attempted;
  readonly schedule: Attempted;
}

const keptRefs = {
  read: makeFunctionReference<"query", {}, string>("kept:read"),
  write: makeFunctionReference<"mutation", {}, string>("kept:write"),
  act: makeFunctionReference<"action", {}, string>("kept:act"),
  rows: makeFunctionReference<"query", {}, Array<string>>("kept:rows"),
  atLoad: makeFunctionReference<"query", {}, KeptCalls | null>("kept:atLoad"),
  keep: makeFunctionReference<"action", {}, null>("kept:keep"),
  around: makeFunctionReference<"action", {}, KeptCalls | null>("kept:around"),
  late: makeFunctionReference<
    "action",
    {},
    KeptCalls & { readonly afterLoad: boolean }
  >("kept:late"),
};

const callThrough = (
  ctx: GenericActionCtx<GenericDataModel>,
): Promise<KeptCalls> =>
  attempted(ctx.runQuery(keptRefs.read, {})).then((runQuery) =>
    attempted(ctx.runMutation(keptRefs.write, {})).then((runMutation) =>
      attempted(ctx.runAction(keptRefs.act, {})).then((runAction) =>
        attempted(ctx.scheduler.runAfter(0, keptRefs.write, {})).then(
          (schedule) => ({ runQuery, runMutation, runAction, schedule }),
        ),
      ),
    ),
  );

/**
 * Backends over one module, `kept.ts`, whose actions keep their context where
 * the next backend's load finds it (#224):
 *
 * - `keep` keeps it and returns.
 * - `around` keeps it while it opens a fresh backend, and returns what that
 *   backend's load settled with.
 * - `late` keeps it while a fresh backend loads `later.ts`, which, for `late`,
 *   chains a promise or starts a `"use node"` timer that calls through it once
 *   the load returned.
 *
 * `kept.ts`'s load calls through a kept context unless `late` kept it. `ran`
 * names each function that ran.
 */
const keptContexts = (late?: "promise" | "timer") => {
  const ran: Array<string> = [];
  const kept: {
    ctx?: GenericActionCtx<GenericDataModel> | undefined;
    late?:
      | {
          readonly ctx: GenericActionCtx<GenericDataModel>;
          readonly loaded: Latch;
          readonly calls: (calls: KeptCalls & { afterLoad: boolean }) => void;
          afterLoad: boolean;
        }
      | undefined;
  } = {};
  const backend = (): KernelControls => {
    const modules = {
      "_generated/server.ts": () => Promise.resolve({}),
      "kept.ts": () => {
        const ctx = kept.ctx;
        const atLoad =
          ctx === undefined ? Promise.resolve(null) : callThrough(ctx);
        return atLoad.then((calls) => ({
          atLoad: queryGeneric({
            args: {},
            handler: () => Promise.resolve(calls),
          }),
          read: queryGeneric({
            args: {},
            handler: () => {
              ran.push("read");
              return Promise.resolve("read");
            },
          }),
          write: mutationGeneric({
            args: {},
            handler: ({ db }) => {
              ran.push("write");
              return db.insert("notes", { label: "kept" }).then(() => "wrote");
            },
          }),
          act: actionGeneric({
            args: {},
            handler: () => {
              ran.push("act");
              return Promise.resolve("acted");
            },
          }),
          rows: queryGeneric({
            args: {},
            handler: ({ db }) =>
              db
                .query("notes")
                .collect()
                .then(Arr.map((row) => row.label)),
          }),
          keep: actionGeneric({
            args: {},
            handler: (actionCtx) => {
              kept.ctx = actionCtx;
              return Promise.resolve(null);
            },
          }),
          around: actionGeneric({
            args: {},
            handler: (actionCtx) => {
              kept.ctx = actionCtx;
              return backend()
                .query(keptRefs.atLoad, {})
                .finally(() => {
                  kept.ctx = undefined;
                });
            },
          }),
          late: actionGeneric({
            args: {},
            handler: (actionCtx) => {
              const { promise, resolve } = Promise.withResolvers<
                KeptCalls & { afterLoad: boolean }
              >();
              const state = {
                ctx: actionCtx,
                loaded: latch(),
                calls: resolve,
                afterLoad: false,
              };
              kept.late = state;
              return backend()
                .query(keptRefs.rows, {})
                .then(() => {
                  state.afterLoad = true;
                  state.loaded.release();
                  return promise;
                })
                .finally(() => {
                  kept.late = undefined;
                });
            },
          }),
        }));
      },
      "later.ts": () => {
        const state = kept.late;
        if (state !== undefined) {
          const probe = () => {
            void state.loaded.promise
              .then(() => {
                const afterLoad = state.afterLoad;
                return callThrough(state.ctx).then((calls) => ({
                  afterLoad,
                  ...calls,
                }));
              })
              .then(state.calls);
          };
          // oxlint-disable-next-line effecttsgo/global-timers -- The case starts a timer while a "use node" module loads, which runs as Node's.
          if (late === "timer") setTimeout(probe, 0);
          else probe();
        }
        return Promise.resolve({
          noop: actionGeneric({
            args: {},
            handler: () => Promise.resolve(null),
          }),
        });
      },
    };
    return convexTest({
      schema: defineSchema({ notes: defineTable({ label: v.string() }) }),
      modules,
      sources: inlineSources(modules, late === "timer" ? ["later.ts"] : []),
    });
  };
  return { backend, ran };
};

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
        expect(Arr.sort(loads.slice(0, -1), Str.Order)).toEqual([
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
      const modules = {
        "_generated/server.ts": recorded("_generated/server"),
        "schema.ts": recorded("schema"),
        "convex.config.ts": recorded("convex.config"),
        "notes.test.ts": recorded("notes.test"),
        ".hidden.ts": recorded(".hidden"),
        "child/convex.config.ts": recorded("child/convex.config"),
        "child/rows.ts": recorded("child/rows"),
        "notes.ts": hostModules["notes.ts"],
      };
      const t = convexTest({
        schema: hostSchema,
        modules,
        sources: inlineSources(modules),
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
        const resolved = yield* Effect.promise(() =>
          t.mutation(makeFunctionReference<"mutation">("runner:run"), {}),
        );
        expect(resolved).toBe("loaded");
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
        // The kit registers its modules without sources, so the test declares
        // the runtime its components' plain actions run in.
        const t = convexTest({
          schema: hostSchema,
          modules: {
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
          },
          componentRuntimes: { "workflow/workpool": "isolate" },
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
              Rec.fromEntries(
                Arr.map(Rec.toEntries(modules), ([path, load]) => {
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
        const deployable = Arr.filter(
          registered,
          (module) =>
            !/\/_generated\/|\/(schema|convex\.config)\.ts$|\.test\.ts$/.test(
              module,
            ),
        );
        expect(deployable).toHaveLength(27);
        expect(loads.at(-1)).toBe("handler");
        expect(Arr.sort(loads.slice(0, -1), Str.Order)).toEqual(
          Arr.sort(deployable, Str.Order),
        );
        expect(
          new Set(
            Arr.map(deployable, (module) => pipe(module, Str.split(" "))[0]),
          ),
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

  // A module load runs under its own backend's guards and environment however
  // deep it nests (#213): backend A's action calls backend B's node action,
  // which opens a fresh backend A whose modules load during that call. A fresh
  // backend whose mount binds no environment reads the host's, never B's.
  it.effect.each([
    { freshWho: "fresh A", case: "its own environment" },
    { freshWho: undefined, case: "the host's environment, binding none," },
  ])(
    "a fresh backend's modules, loaded inside a node action that another backend's action called, read $case and the isolate's globals, and each caller keeps its own",
    ({ freshWho }) =>
      Effect.gen(function* () {
        type Seen = {
          readonly who: string | null;
          readonly setImmediate: string;
          readonly queueMicrotask: string;
        };
        type Chain = {
          readonly fresh: Seen;
          readonly middle: Seen;
          readonly outer: Seen;
        };
        type Kernel = KernelControls & {
          readonly setEnvironment: (
            componentPath: string,
            env: Readonly<Record<string, string>>,
          ) => void;
        };
        const seen = (): Seen => ({
          // oxlint-disable-next-line effecttsgo/process-env -- The case reads the environment the kernel scopes to each load and function.
          who: process.env["WHO"] ?? null,
          setImmediate: typeof setImmediate,
          queueMicrotask: typeof queueMicrotask,
        });
        const refs = {
          atLoad: makeFunctionReference<"query", {}, Seen>("probe:atLoad"),
          middle: makeFunctionReference<
            "action",
            {},
            { fresh: Seen; middle: Seen }
          >("chain:middle"),
          outer: makeFunctionReference<"action", {}, Chain>("chain:outer"),
        };
        const backend = (
          who: string | undefined,
          next?: () => Kernel,
        ): Kernel => {
          const modules = {
            "_generated/server.ts": () => Promise.resolve({}),
            "probe.ts": () => {
              const atLoad = seen();
              return Promise.resolve({
                atLoad: queryGeneric({
                  args: {},
                  handler: () => Promise.resolve(atLoad),
                }),
              });
            },
            "chain.ts": () =>
              Promise.resolve({
                // B's node action: it opens the fresh backend, whose first
                // call loads its modules, then reads its own surroundings.
                middle: actionGeneric({
                  args: {},
                  handler: () =>
                    next!()
                      .query(refs.atLoad, {})
                      .then((fresh: Seen) => ({ fresh, middle: seen() })),
                }),
                // A's node action, which calls into B.
                outer: actionGeneric({
                  args: {},
                  handler: () =>
                    next!()
                      .action(refs.middle, {})
                      .then((inner: { fresh: Seen; middle: Seen }): Chain => ({
                        ...inner,
                        outer: seen(),
                      })),
                }),
              }),
          };
          const t = convexTest({
            schema: defineSchema({}),
            modules,
            sources: inlineSources(modules, ["chain.ts"]),
          }) as Kernel;
          if (who !== undefined) t.setEnvironment("", { WHO: who });
          return t;
        };
        const b = backend("B", () => backend(freshWho));
        const a = backend("A", () => b);
        const chain: Chain = yield* Effect.promise(() =>
          a.action(refs.outer, {}),
        );
        const node = { setImmediate: "function", queueMicrotask: "function" };
        expect(chain).toEqual({
          fresh: {
            // Read from test code, outside any kernel function: the host's.
            who: freshWho ?? seen().who,
            setImmediate: "undefined",
            queueMicrotask: "undefined",
          },
          middle: { who: "B", ...node },
          outer: { who: "A", ...node },
        });
      }),
  );

  // The reverse nesting: a module whose top level calls another backend's
  // query, which binds no environment, so the query reads the host's, never
  // the loading module's.
  it.effect(
    "a backend that a module calls while it loads reads its own component's environment, in its query and in its own modules' load, not the loading module's",
    () =>
      Effect.gen(function* () {
        type Kernel = KernelControls & {
          readonly setEnvironment: (
            componentPath: string,
            env: Readonly<Record<string, string>>,
          ) => void;
        };
        // oxlint-disable-next-line effecttsgo/process-env -- The case reads the environment the kernel scopes to each load and function.
        const who = (): string | null => process.env["WHO"] ?? null;
        const refs = {
          who: makeFunctionReference<"query", {}, string>("probe:who"),
          atLoad: makeFunctionReference<
            "query",
            {},
            { own: string | null; called: string }
          >("probe:atLoad"),
        };
        const kernel = (modules: Record<string, () => Promise<unknown>>) => {
          const all = {
            "_generated/server.ts": () => Promise.resolve({}),
            ...modules,
          };
          return convexTest({
            schema: defineSchema({}),
            modules: all,
            sources: inlineSources(all),
          }) as Kernel;
        };
        // Its modules load inside the other backend's load, as its first call
        // comes from there.
        const other = kernel({
          "probe.ts": () => {
            const atLoad = who();
            return Promise.resolve({
              who: queryGeneric({
                args: {},
                handler: () => Promise.resolve(`${who()}|${atLoad}`),
              }),
            });
          },
        });
        const loading = kernel({
          "probe.ts": () => {
            const own = who();
            return other.query(refs.who, {}).then((called: string) => ({
              atLoad: queryGeneric({
                args: {},
                handler: () => Promise.resolve({ own, called }),
              }),
            }));
          },
        });
        loading.setEnvironment("", { WHO: "loading" });
        const seenAtLoad = yield* Effect.promise(() =>
          loading.query(refs.atLoad, {}),
        );
        // Read from test code, outside any kernel function: the host's, which
        // the other backend's query and its load both read.
        const host = who();
        expect(seenAtLoad).toEqual({
          own: "loading",
          called: `${host}|${host}`,
        });
      }),
  );

  // Convex runs no syscall while a module loads. A load inside a mutation, as
  // a fresh backend's first call from it makes, is no exception: a module that
  // writes through a context it was handed is refused, and never reaches the
  // mutation's transaction (#213).
  it.effect(
    "a syscall a fresh backend's module makes while it loads inside another backend's mutation, which an action called, is refused, and the mutation's database stays empty",
    () =>
      Effect.gen(function* () {
        const captured: {
          ctx?: GenericMutationCtx<GenericDataModel> | undefined;
        } = {};
        const refs = {
          inserted: makeFunctionReference<"query", {}, unknown>(
            "leak:inserted",
          ),
          middle: makeFunctionReference<"mutation", {}, unknown>("leak:middle"),
          outer: makeFunctionReference<"action", {}, unknown>("leak:outer"),
          rows: makeFunctionReference<"query", {}, Array<string>>("leak:rows"),
        };
        const schema = defineSchema({
          notes: defineTable({ label: v.string() }),
        });
        const backend = (peer?: () => KernelControls): KernelControls => {
          const modules = {
            "_generated/server.ts": () => Promise.resolve({}),
            "leak.ts": () => {
              const kept = captured.ctx;
              const attempt =
                kept === undefined
                  ? Promise.resolve<unknown>("no context")
                  : kept.db.insert("notes", { label: "leak" }).then(
                      (id) => ({ inserted: id }),
                      (error: Error) => ({ refused: error.message }),
                    );
              return attempt.then((inserted) => ({
                inserted: queryGeneric({
                  args: {},
                  handler: () => Promise.resolve(inserted),
                }),
                rows: queryGeneric({
                  args: {},
                  handler: ({ db }) =>
                    db
                      .query("notes")
                      .collect()
                      .then(Arr.map((row) => row.label)),
                }),
                middle: mutationGeneric({
                  args: {},
                  handler: (ctx) => {
                    captured.ctx = ctx;
                    return peer!()
                      .query(refs.inserted, {})
                      .finally(() => {
                        captured.ctx = undefined;
                      });
                  },
                }),
                outer: actionGeneric({
                  args: {},
                  handler: () => peer!().mutation(refs.middle, {}),
                }),
              }));
            },
          };
          return convexTest({
            schema,
            modules,
            sources: inlineSources(modules),
          });
        };
        const b = backend(() => backend());
        const a = backend(() => b);
        const inserted = yield* Effect.promise(() => a.action(refs.outer, {}));
        expect(inserted).toEqual({ refused: outsideFunction });
        const rows = yield* Effect.promise(() => b.query(refs.rows, {}));
        expect(rows).toEqual([]);
      }),
  );

  // An action's own `ctx.runQuery`, `ctx.runMutation` and `ctx.runAction` call
  // the kernel directly, not through `globalThis.Convex`, so the dispatcher's
  // refusal at load does not cover them. A module load that calls them through
  // a context an action kept is refused as its syscalls are, and starts
  // nothing (#224). Each case also schedules through the kept context, which
  // goes through the dispatcher.
  const refusedThroughContext: KeptCalls = {
    runQuery: { error: outsideFunction },
    runMutation: { error: outsideFunction },
    runAction: { error: outsideFunction },
    schedule: { error: outsideFunction },
  };

  it.effect.each([
    { when: "while that action waits on the load", keeper: keptRefs.around },
    { when: "after that action returned", keeper: keptRefs.keep },
  ])(
    "a module load that calls a function through an action's kept context, $when, is refused, and nothing runs",
    ({ keeper }) =>
      Effect.gen(function* () {
        const kept = keptContexts();
        const a = kept.backend();
        const around = yield* Effect.promise(() => a.action(keeper, {}));
        const calls =
          around ??
          (yield* Effect.promise(() =>
            kept.backend().query(keptRefs.atLoad, {}),
          ));
        expect(calls).toEqual(refusedThroughContext);
        expect(kept.ran).toEqual([]);
        const rows = yield* Effect.promise(() => a.query(keptRefs.rows, {}));
        expect(rows).toEqual([]);
      }),
  );

  // A callback a load starts runs as that load, however late it settles: a
  // promise it chained, or a `"use node"` module's timer, whose callback calls
  // through the kept context only after the load returned.
  it.effect.each(["promise", "timer"] as const)(
    "a %s a module load started, settling after the load, is refused when it calls through an action's kept context, and nothing runs",
    (late) =>
      Effect.gen(function* () {
        const kept = keptContexts(late);
        const a = kept.backend();
        const calls = yield* Effect.promise(() => a.action(keptRefs.late, {}));
        expect(calls).toEqual({ afterLoad: true, ...refusedThroughContext });
        expect(kept.ran).toEqual([]);
        const rows = yield* Effect.promise(() => a.query(keptRefs.rows, {}));
        expect(rows).toEqual([]);
      }),
  );

  // Another library's `globalThis.Convex`, such as convex-test's, answers
  // syscalls made outside every kernel function. A load is no such place: what
  // it calls is refused, and that backend sees nothing.
  it.effect(
    "a module load that calls through an action's kept context, with another library's globalThis.Convex installed, is refused, and that backend sees no syscall",
    () =>
      Effect.gen(function* () {
        const kept = keptContexts();
        const a = kept.backend();
        yield* Effect.promise(() => a.action(keptRefs.keep, {}));
        expect(Execution.ownsConvexGlobal()).toBe(true);
        const seen: Array<string> = [];
        const foreign = {
          syscall: (op: string) => {
            seen.push(op);
            return "null";
          },
          asyncSyscall: (op: string) => {
            seen.push(op);
            return Promise.resolve("null");
          },
          jsSyscall: (op: string) => {
            seen.push(op);
            return null;
          },
        };
        const global = globalThis as { Convex?: unknown };
        const calls = yield* Effect.promise(() => {
          global.Convex = foreign;
          return kept.backend().query(keptRefs.atLoad, {});
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              global.Convex = undefined;
            }),
          ),
        );
        expect(Execution.ownsConvexGlobal()).toBe(true);
        expect(calls).toEqual(refusedThroughContext);
        expect(seen).toEqual([]);
        expect(kept.ran).toEqual([]);
        const rows = yield* Effect.promise(() => a.query(keptRefs.rows, {}));
        expect(rows).toEqual([]);
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
            .then((rows) => Arr.map(rows, (row) => row.what)),
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
            .then((rows) => Arr.map(rows, ({ label, at }) => ({ label, at }))),
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
                what: `page ${pipe(
                  page,
                  Arr.map((row) => row.key),
                  Arr.join(","),
                )}`,
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
        const callResult = yield* call(() => t.apply(second.id));
        const next = conflicted(callResult);
        const retried = yield* call(() => t.apply(next.id));
        expect([applied.kind, next.number, retried.kind]).toEqual([
          "applied",
          2,
          "applied",
        ]);
        const callResult2 = yield* call(() => t.query(occ.counter, { id }));
        expect(callResult2).toBe(2);
      }),
  );

  it.effect(
    "two held attempts applied together publish one at its own version and conflict the other",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const id = yield* call(() => t.mutation(occ.create, {}));
        const first = yield* call(() => t.prepare(occ.bump, { id }));
        const second = yield* call(() => t.prepare(occ.bump, { id }));
        const [applied, conflict] = yield* call(() =>
          Promise.all([t.apply(first.id), t.apply(second.id)]),
        );
        expect(applied).toMatchObject({ kind: "applied", version: 2 });
        const next = conflicted(conflict);
        const callResult = yield* call(() => t.apply(next.id));
        expect(callResult).toMatchObject({
          kind: "applied",
          version: 3,
        });
        const callResult2 = yield* call(() => t.query(occ.counter, { id }));
        expect(callResult2).toBe(2);
      }),
  );

  it.effect(
    "concurrent mutations each publish once, because a conflicting attempt runs again",
    () =>
      Effect.gen(function* () {
        const t = occWorld();
        const id = yield* call(() => t.mutation(occ.create, {}));
        yield* call(() =>
          Promise.all(Arr.map([1, 2, 3], () => t.mutation(occ.bump, { id }))),
        );
        const callResult = yield* call(() => t.query(occ.counter, { id }));
        expect(callResult).toBe(3);
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
        const callResult = yield* call(() => t.apply(lookup.id));
        const next = conflicted(callResult);
        yield* call(() => t.apply(next.id));
        const callResult2 = yield* call(() => t.query(occ.seen, {}));
        expect(callResult2).toEqual(["present"]);
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
        const callResult = yield* call(() => t.apply(inside.id));
        const next = conflicted(callResult);
        yield* call(() => t.apply(next.id));
        expect(valid.kind).toBe("applied");
        const callResult2 = yield* call(() => t.query(occ.seen, {}));
        expect(callResult2).toEqual(["1", "0"]);
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
        const callResult = yield* call(() => t.apply(phantom.id));
        const next = conflicted(callResult);
        yield* call(() => t.apply(next.id));
        expect(valid.kind).toBe("applied");
        const callResult2 = yield* call(() => t.query(occ.seen, {}));
        expect(callResult2).toEqual(["free x", "taken x"]);
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
        const callResult = yield* call(() => t.apply(first.id));
        const next = conflicted(callResult);
        yield* call(() => t.apply(next.id));
        expect([cursor, valid.kind]).toEqual(["_end_cursor", "applied"]);
        const callResult2 = yield* call(() => t.query(occ.seen, {}));
        expect(callResult2).toEqual(["page ", "page 1,2"]);
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
        const callResult = yield* call(() => t.apply(inside.id));
        const next = conflicted(callResult);
        yield* call(() => t.apply(next.id));
        expect(valid.kind).toBe("applied");
        const callResult2 = yield* call(() => t.query(occ.seen, {}));
        expect(callResult2).toEqual(["page 1", "page 1,2"]);
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
          const callResult = yield* call(() => t.apply(attempt.id));
          attempt = conflicted(callResult);
          numbers.push(attempt.number);
        }
        yield* call(() => t.mutation(occ.bump, { id }));
        const exhausted = yield* call(() => t.apply(attempt.id));
        expect(numbers).toEqual([2, 3, 4, 5]);
        expect(exhausted).toMatchObject({
          kind: "exhausted",
          error: { _tag: "OptimisticConcurrencyControlFailure" },
        });
        const callResult2 = yield* call(() => t.query(occ.counter, { id }));
        expect(callResult2).toBe(5);
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
        const callResult = yield* call(() => t.apply(held.id));
        const next = conflicted(callResult);
        yield* call(() => t.apply(next.id));
        const callResult2 = yield* call(() => t.query(occ.seen, {}));
        expect(callResult2).toEqual(["read 1"]);
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
        const callResult = yield* call(() => t.apply(held.id));
        const next = conflicted(callResult);
        yield* call(() => t.apply(next.id));
        const callResult2 = yield* call(() => t.query(occ.seen, {}));
        expect(callResult2).toEqual(["after failure"]);
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
        const callResult = yield* call(() => t.query(occ.stamps, {}));
        expect(callResult).toEqual([
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
        const callResult = yield* call(() => t.query(occ.stamps, {}));
        expect(callResult).toEqual([
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
      const callResult = yield* call(() => t.query(occ.stamps, {}));
      expect(callResult).toEqual([{ label: "first", at: 7n }]);
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
      Json.parse(one.stdout),
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
    expect(Arr.map(state.stamps, (stamp) => stamp.at)).toEqual([
      at(4n),
      at(5n),
    ]);
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
        const callResult = yield* call(() => t.apply(held.id));
        const next = conflicted(callResult);
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
        const callResult = yield* call(() =>
          Invocation.bind(caller, () => t.reference()),
        );
        expect(callResult).toEqual([]);
      }),
  );
});

const convexErrorModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "convexErrors.ts": () =>
    import("../../../tools/local-backend/fixtures/plain/convex/convexErrors"),
  "http.ts": () =>
    import("../../../tools/local-backend/fixtures/plain/convex/http"),
};

// The plain fixture's files as their own sources.
const convexErrorWorld = () =>
  withSources(convexErrorModules, {
    "convexErrors.ts": plainSource("convexErrors.ts"),
    "http.ts": plainSource("http.ts"),
  });

const convexErrors = {
  throwingQuery: makeFunctionReference<"query", { payload: Payload }>(
    "convexErrors:throwingQuery",
  ),
  throwingMutation: makeFunctionReference<"mutation", { payload: Payload }>(
    "convexErrors:throwingMutation",
  ),
  throwingAction: makeFunctionReference<"action", { payload: Payload }>(
    "convexErrors:throwingAction",
  ),
  queryCaller: makeFunctionReference<"query", { payload: Payload }, Caught>(
    "convexErrors:queryCaller",
  ),
  mutationCaller: makeFunctionReference<
    "mutation",
    { payload: Payload; target: "query" | "mutation" },
    Caught
  >("convexErrors:mutationCaller"),
  actionCaller: makeFunctionReference<
    "action",
    { payload: Payload; target: Target },
    Caught
  >("convexErrors:actionCaller"),
};

/**
 * The kernel with its HTTP entry point, which the shim returns untyped.
 */
type ConvexErrorWorld = KernelControls & {
  readonly fetch: (path: string) => Promise<Response>;
};

type ConvexErrorCase =
  | { readonly caller: "query"; readonly target: "query" }
  | { readonly caller: "mutation"; readonly target: "query" | "mutation" }
  | { readonly caller: "action" | "HTTP action"; readonly target: Target };

/**
 * What reaches `caller` when it calls a `target` that throws with `payload`
 * data. An action's `ctx.run*` reach the kernel directly, and an HTTP action's
 * go through Convex's action syscalls.
 */
const caughtIn = (
  t: ConvexErrorWorld,
  { caller, target }: ConvexErrorCase,
  payload: Payload,
): Promise<Caught> => {
  switch (caller) {
    case "query":
      return t.query(convexErrors.queryCaller, { payload });
    case "mutation":
      return t.mutation(convexErrors.mutationCaller, { payload, target });
    case "action":
      return t.action(convexErrors.actionCaller, { payload, target });
    case "HTTP action":
      return t
        .fetch(`/nested-convex-error?payload=${payload}&target=${target}`)
        .then((response) => response.json())
        .then((json) => jsonToConvex(json) as Caught);
  }
};

const convexErrorCases: ReadonlyArray<ConvexErrorCase> = [
  { caller: "query", target: "query" },
  { caller: "mutation", target: "query" },
  { caller: "mutation", target: "mutation" },
  { caller: "action", target: "query" },
  { caller: "action", target: "mutation" },
  { caller: "action", target: "action" },
  { caller: "HTTP action", target: "query" },
  { caller: "HTTP action", target: "mutation" },
  { caller: "HTTP action", target: "action" },
];

const payloadNames = Rec.keys(payloads) as ReadonlyArray<Payload>;

describe("nested ConvexError data", () => {
  it.effect.each(
    Arr.flatMap(payloadNames, (payload) =>
      Arr.map(convexErrorCases, (c) => ({ ...c, payload })),
    ),
  )(
    "a ConvexError with $payload data thrown in a called $target reaches its $caller caller as that ConvexError and data",
    ({ payload, ...c }) =>
      Effect.gen(function* () {
        const t: ConvexErrorWorld = convexTest(convexErrorWorld());
        const caught = yield* call(() => caughtIn(t, c, payload));
        expect(caught).toEqual({
          convexError: true,
          data: payloads[payload](),
        });
      }),
  );

  it.effect.each(
    Arr.flatMap(payloadNames, (payload) =>
      Arr.map(["query", "mutation", "action"] as const, (kind) => ({
        kind,
        payload,
      })),
    ),
  )(
    "a ConvexError with $payload data thrown in the $kind the test calls reaches it with that data as a Convex value",
    ({ kind, payload }) =>
      Effect.gen(function* () {
        const t: KernelControls = convexTest(convexErrorWorld());
        const run = (): Promise<unknown> =>
          kind === "query"
            ? t.query(convexErrors.throwingQuery, { payload })
            : kind === "mutation"
              ? t.mutation(convexErrors.throwingMutation, { payload })
              : t.action(convexErrors.throwingAction, { payload });
        const error = yield* call(() =>
          run().then(
            () => undefined,
            (thrown: unknown) => thrown,
          ),
        );
        assert(error instanceof ConvexError);
        expect(error.data).toEqual(payloads[payload]());
      }),
  );
});

// Two copies of this package in one plain Node process (#159), registering in
// either order. `globalThis.Convex`, the realm's `Date` wrapper and the
// `process.env` proxy are one per process, installed by the first copy.
describe.each(orders)("two loaded copies, %s", (registration) => {
  it("each copy's syscalls reach its own world, and its query reads its own invocation's time and environment", () => {
    const { kernel } = twoCopiesReport(registration);
    expect(kernel.one).toMatchObject({
      read: { value: { labels: ["one"], now: times.one } },
      who: { value: "one" },
    });
    expect(kernel.two).toMatchObject({
      read: { value: { labels: ["two"], now: times.two } },
      who: { value: "two" },
    });
  }, 60_000);

  it("a copy's query called from the other copy's action reaches the inner world and reads the inner invocation's time and environment, and the outer action keeps its own, either way", () => {
    const { nested } = twoCopiesReport(registration);
    expect(nested.twoInOne.result).toMatchObject({
      value: {
        read: { value: { labels: ["nested"], now: times.two } },
        who: { value: "two" },
        outerNow: times.one,
        outerWho: "one",
      },
    });
    expect(nested.oneInTwo.result).toMatchObject({
      value: {
        read: { value: { labels: ["nested"], now: times.one } },
        who: { value: "one" },
        outerNow: times.two,
        outerWho: "two",
      },
    });
  }, 60_000);

  it("a fresh backend whose modules load inside the other copy's action, which its own copy's action called, reads its own environment at load, and each action keeps its own, either way", () => {
    const { chain } = twoCopiesReport(registration);
    for (const [run, outer, middle] of [
      [chain.oneTwoOne, "one", "two"],
      [chain.twoOneTwo, "two", "one"],
    ] as const) {
      expect(run).toMatchObject({
        value: {
          fresh: { who: "fresh" },
          middle: { who: middle },
          outer: { who: outer },
        },
      });
    }
  }, 60_000);

  it("a syscall a fresh backend's module makes while it loads inside the other copy's mutation is refused, and that mutation's database stays empty, either way", () => {
    const { leak } = twoCopiesReport(registration);
    for (const run of [leak.oneTwoOne, leak.twoOneTwo]) {
      expect(run).toEqual({
        inserted: { value: { error: outsideFunction } },
        middleRows: { value: { labels: [], now: expect.any(Number) } },
      });
    }
  }, 60_000);

  it("a module load on one copy that calls a function through the other copy's kept action context is refused, and that action's database stays empty, either way", () => {
    const { kept } = twoCopiesReport(registration);
    for (const run of [kept.oneTwo, kept.twoOne]) {
      expect(run).toEqual({
        calls: {
          value: {
            runQuery: { error: outsideFunction },
            runMutation: { error: outsideFunction },
            runAction: { error: outsideFunction },
          },
        },
        keeperRows: { value: { labels: [], now: expect.any(Number) } },
      });
    }
  }, 60_000);
});

// The current source beside a published build from before #213, which shares
// the v1 stores and registries (`Owner`), registering in either order. A
// function of one copy that opens a fresh backend on the other, which binds no
// environment, must leave that backend's loads, queries and mutations the
// host's environment, and a load inside one copy's mutation must write nothing
// into it.
describe.each(orders)(
  "an older build loaded beside this one, %s",
  (registration) => {
    it("a fresh backend on either copy, opened from the other copy's function, reads the host's environment at load and in its queries and mutations", () => {
      const { host, env } = mixedCopiesReport(registration);
      expect(host).not.toBe("outer-env");
      const fresh = {
        freshAtLoad: host,
        freshQuery: host,
        freshMutation: host,
        outer: "outer-env",
      };
      expect(env).toEqual({
        newerOuter: { value: fresh },
        olderOuter: { value: fresh },
      });
    }, 60_000);

    it("a syscall a fresh backend's module makes while it loads inside the other copy's mutation is refused, and that mutation's database stays empty", () => {
      const { leak } = mixedCopiesReport(registration);
      for (const run of [leak.newerMutation, leak.olderMutation]) {
        expect(run).toEqual({
          inserted: { value: { error: expect.any(String) } },
          rows: { value: [] },
        });
      }
    }, 60_000);

    // The older build's own kept contexts call the kernel unchecked, which a
    // newer copy cannot change, so only the newer copy's are refused.
    it("a module load on the older copy that calls a function through the newer copy's kept action context is refused, and that action's database stays empty", () => {
      const { kept } = mixedCopiesReport(registration);
      expect(kept.newerAction).toEqual({
        calls: {
          value: {
            runQuery: { error: outsideFunction },
            runMutation: { error: outsideFunction },
            runAction: { error: outsideFunction },
          },
        },
        rows: { value: [] },
      });
    }, 60_000);
  },
);

// An older copy of this package, from before #159, that loaded first holds a
// process-wide hook that answers for that copy alone. Simulated in a fresh
// Node process, one hook at a time.
describe("an older copy loaded first", () => {
  it("refuses to open a backend with OlderCopyLoadedFirst naming the hook it holds, before registering anything, through the kernel and TestConfect.layer", () => {
    const report = reportOf<{
      readonly atImport: boolean;
      readonly kernel: Record<string, unknown>;
      readonly layer: unknown;
      readonly control: string;
    }>("olderCopy.ts", runFixture("olderCopy.ts", []));
    expect(report.atImport).toBe(false);
    const refused = (hook: string) => ({
      tag: "OlderCopyLoadedFirst",
      hooks: [hook],
      message: expect.stringContaining(
        "An older copy of @confect/test loaded first in this process",
      ),
    });
    for (const hook of [
      "Convex",
      "ioGuards",
      "Date",
      "providerPorts",
      "processEnv",
    ]) {
      expect(report.kernel[hook]).toEqual({
        ...refused(hook),
        registered: false,
      });
    }
    expect(report.layer).toEqual(refused("Convex"));
    expect(report.control).toBe("pong");
  }, 60_000);
});
