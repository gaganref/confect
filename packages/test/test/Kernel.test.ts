import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { describe, expect, it } from "@effect/vitest";
import {
  actionGeneric,
  componentsGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
} from "convex/server";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import { convexTest } from "../src/internal/ConvexTest";

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
