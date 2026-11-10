import { describe, expect, it } from "@effect/vitest";
import {
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
};

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
