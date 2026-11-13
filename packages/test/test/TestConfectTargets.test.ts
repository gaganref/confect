import { TestConfect } from "@confect/test";
import { DatabaseSchema, MutationCtx } from "@confect/server";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Arr from "effect/Array";

const schema = DatabaseSchema.make({});
const Test = TestConfect.TestConfect<typeof schema>();
const layer = (target: TestConfect.Target) =>
  TestConfect.layer(
    schema,
    defineSchema({ notes: defineTable({ text: v.string() }) }),
    { "_generated/server.ts": () => Promise.resolve({}) },
    { target },
  );

const Texts = Schema.mutable(Schema.Array(Schema.String));

const withCtx = <A>(
  use: (ctx: MutationCtx.MutationCtx<GenericDataModel>) => Promise<A>,
) =>
  Effect.gen(function* () {
    const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
    return yield* Effect.promise(() => use(ctx));
  });

const texts = (ctx: MutationCtx.MutationCtx<GenericDataModel>) =>
  ctx.db
    .query("notes")
    .collect()
    .then((rows) => Arr.map(rows, (row) => row.text as string));

const insert = (test: TestConfect.TestConfect<typeof schema>, text: string) =>
  test.run(withCtx((ctx) => ctx.db.insert("notes", { text })));

const read = (test: TestConfect.TestConfect<typeof schema>) =>
  test.run(withCtx(texts), Texts);

// Both targets answer Convex's server library through the one
// `globalThis.Convex`, and convex-test installs its own only the first time it
// builds a world. This case runs first, so that install lands while a kernel
// function is held between two syscalls.
it.effect(
  "a kernel function in flight keeps the kernel while a convex-test layer starts",
  () =>
    Effect.gen(function* () {
      const kernel = yield* Test;
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const held = yield* kernel
        .run(
          withCtx((ctx) =>
            ctx.db
              .insert("notes", { text: "held" })
              .then(() => {
                reached.resolve();
                return gate.promise;
              })
              .then(() => texts(ctx)),
          ),
          Texts,
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      yield* Effect.gen(function* () {
        const other = yield* Test;
        yield* insert(other, "other");
        const readResult = yield* read(other);
        expect(readResult).toEqual(["other"]);
      }).pipe(Effect.provide(layer("convex-test")));
      gate.resolve();
      const joined = yield* Fiber.join(held);
      expect(joined).toEqual(["held"]);
    }).pipe(Effect.provide(layer("kernel"))),
);

it.effect.each([
  { outer: "kernel", inner: "convex-test" },
  { outer: "convex-test", inner: "kernel" },
] as const)(
  "a live $outer layer keeps its backend beside and after an inner $inner layer",
  ({ outer, inner }) =>
    Effect.gen(function* () {
      const first = yield* Test;
      yield* insert(first, "outer");
      yield* Effect.gen(function* () {
        const second = yield* Test;
        const readResult = yield* read(second);
        expect(readResult).toEqual([]);
        yield* insert(second, "inner");
        const readResult2 = yield* read(second);
        expect(readResult2).toEqual(["inner"]);
        const readResult3 = yield* read(first);
        expect(readResult3).toEqual(["outer"]);
      }).pipe(Effect.provide(layer(inner)));
      const readResult = yield* read(first);
      expect(readResult).toEqual(["outer"]);
    }).pipe(Effect.provide(layer(outer))),
);

// Both targets give each function call its own `Date`, `Math` and `crypto`
// through an accessor on `globalThis`, and each installs its own again when
// another is on top. Wrapping each other at every call would deepen every read
// of these globals for as long as both layers are live.
it.effect(
  "calls alternating between a kernel and a convex-test layer keep each pinned global's accessor, instead of wrapping it again at every call",
  () =>
    Effect.gen(function* () {
      const kernel = yield* Test;
      yield* Effect.gen(function* () {
        const other = yield* Test;
        const tops = () =>
          Arr.map(
            ["Date", "Math", "crypto"] as const,
            (name) => Object.getOwnPropertyDescriptor(globalThis, name)?.get,
          );
        yield* insert(kernel, "kernel");
        yield* insert(other, "other");
        const settled = tops();
        for (let round = 0; round < 20; round++) {
          yield* insert(kernel, "kernel");
          yield* insert(other, "other");
        }
        expect(tops()).toEqual(settled);
      }).pipe(Effect.provide(layer("convex-test")));
    }).pipe(Effect.provide(layer("kernel"))),
);

const notes = {
  add: makeFunctionReference<"mutation", { text: string }>("notes:add"),
  list: makeFunctionReference<"query", {}, Array<string>>("notes:list"),
};

const kernelNotes = (): KernelControls =>
  convexTest({
    schema: defineSchema({ notes: defineTable({ text: v.string() }) }),
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "notes.ts": () =>
        Promise.resolve({
          add: mutationGeneric({
            args: { text: v.string() },
            handler: (ctx, { text }) => ctx.db.insert("notes", { text }),
          }),
          list: queryGeneric({
            args: {},
            handler: (ctx) =>
              ctx.db
                .query("notes")
                .collect()
                .then((rows) => Arr.map(rows, (row) => row.text)),
          }),
        }),
    },
  });

// A kernel subscription's reruns reach Convex's server library through the same
// `globalThis.Convex` and pinned globals that a live convex-test layer uses.
it.effect(
  "a kernel subscription beside a live convex-test layer reruns on a conflicting kernel commit only, and keeps each pinned global's accessor",
  () =>
    Effect.gen(function* () {
      const t = kernelNotes();
      yield* Effect.promise(() => t.mutation(notes.add, { text: "a" }));
      const subscription = yield* Effect.promise(() =>
        t.subscriber().subscribe(notes.list, {}),
      );
      yield* Effect.gen(function* () {
        const other = yield* Test;
        yield* insert(other, "other");
        yield* Effect.promise(() => t.refresh());
        const tops = () =>
          Arr.map(
            ["Date", "Math", "crypto"] as const,
            (name) => Object.getOwnPropertyDescriptor(globalThis, name)?.get,
          );
        const settled = tops();
        const resolved = yield* Effect.promise(() => t.refresh());
        expect(resolved).toEqual([]);
        yield* insert(other, "other again");
        const resolved2 = yield* Effect.promise(() => t.refresh());
        expect(resolved2).toEqual([]);
        yield* Effect.promise(() => t.mutation(notes.add, { text: "b" }));
        const reran = yield* Effect.promise(() => t.refresh());
        expect(reran).toMatchObject([
          {
            subscription: subscription.id,
            to: { _tag: "returned", value: ["a", "b"] },
          },
        ]);
        const resolved3 = yield* Effect.promise(() => t.reference());
        expect(resolved3).toEqual([]);
        const readResult = yield* read(other);
        expect(readResult).toEqual(["other", "other again"]);
        expect(tops()).toEqual(settled);
      }).pipe(Effect.provide(layer("convex-test")));
    }),
);
