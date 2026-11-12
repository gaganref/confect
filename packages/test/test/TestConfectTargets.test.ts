import { TestConfect } from "@confect/test";
import { DatabaseSchema, MutationCtx } from "@confect/server";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import {
  defineSchema,
  defineTable,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";

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
    .then((rows) => rows.map((row) => row.text as string));

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
        expect(yield* read(other)).toEqual(["other"]);
      }).pipe(Effect.provide(layer("convex-test")));
      gate.resolve();
      expect(yield* Fiber.join(held)).toEqual(["held"]);
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
        expect(yield* read(second)).toEqual([]);
        yield* insert(second, "inner");
        expect(yield* read(second)).toEqual(["inner"]);
        expect(yield* read(first)).toEqual(["outer"]);
      }).pipe(Effect.provide(layer(inner)));
      expect(yield* read(first)).toEqual(["outer"]);
    }).pipe(Effect.provide(layer(outer))),
);
