// One history on the test kernel, printed as bytes. `Kernel.test.ts` runs this
// file in two processes and compares their output.
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { convexToJson, v, type GenericId } from "convex/values";
import * as Effect from "effect/Effect";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";
import * as Array from "effect/Array";
import * as Schema from "effect/Schema";

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const schema = defineSchema({
  counters: defineTable({ n: v.number() }),
  stamps: defineTable({ label: v.string(), at: v.commitTs() }),
});

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "replay.ts": () =>
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
            .then((counter) => ctx.db.patch(id, { n: counter!.n + 1 })),
      }),
      stamp: mutationGeneric({
        args: { label: v.string() },
        handler: (ctx, { label }) =>
          ctx.db.insert("stamps", { label, at: ctx.db.vars.commitTs }),
      }),
      dump: queryGeneric({
        args: {},
        handler: (ctx) =>
          Promise.all([
            ctx.db.query("counters").collect(),
            ctx.db.query("stamps").collect(),
          ]).then(([counters, stamps]) => ({ counters, stamps })),
      }),
    }),
};

const replay = {
  create: makeFunctionReference<"mutation", {}, GenericId<"counters">>(
    "replay:create",
  ),
  bump: makeFunctionReference<"mutation", { id: GenericId<"counters"> }>(
    "replay:bump",
  ),
  stamp: makeFunctionReference<"mutation", { label: string }>("replay:stamp"),
  dump: makeFunctionReference<"query">("replay:dump"),
};

const history = Effect.gen(function* () {
  let clock = 1_767_225_600_000;
  const t: KernelControls = convexTest({
    schema,
    modules,
    runtime: {
      now: () => clock++,
      commitTs: (version: number) =>
        1_767_225_600_000_000_000n + BigInt(version) * 1_000n,
    },
  });
  const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);
  const id = yield* call(() => t.mutation(replay.create, {}));
  const first = yield* call(() => t.prepare(replay.bump, { id }));
  const second = yield* call(() => t.prepare(replay.bump, { id }));
  const applied = yield* call(() => t.apply(second.id));
  const conflict = yield* call(() => t.apply(first.id));
  if (conflict.kind !== "conflict") throw new Error("expected a conflict");
  const retried = yield* call(() => t.apply(conflict.next.id));
  yield* call(() => t.mutation(replay.stamp, { label: "first" }));
  yield* call(() => t.mutation(replay.stamp, { label: "second" }));
  const state = yield* call(() => t.query(replay.dump, {}));
  const steps = Array.map([applied, conflict, retried], (step) =>
    step.kind === "conflict"
      ? { kind: step.kind, next: step.next.number }
      : step.kind === "applied"
        ? { kind: step.kind, version: step.version, commitTs: step.commitTs }
        : { kind: step.kind },
  );
  const output = yield* jsonText(convexToJson({ steps, state }));
  process.stdout.write(output);
});

void Effect.runPromise(history);
