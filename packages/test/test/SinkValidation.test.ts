import { describe, expect, it } from "@effect/vitest";
import { defineSchema, defineTable, mutationGeneric } from "convex/server";
import { v, type GenericValidator } from "convex/values";
import * as Effect from "effect/Effect";
import { convexTest } from "../src/internal/ConvexTest";
import { inlineSources } from "./fixtures/inlineSources";

const schema = defineSchema({
  documents: defineTable({}),
  others: defineTable({}),
});

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "host.ts": () =>
    Promise.resolve({
      make: mutationGeneric({
        args: {},
        handler: (ctx) => ctx.db.insert("others", {}),
      }),
      normalize: mutationGeneric({
        args: { id: v.string() },
        handler: (ctx, { id }) => ctx.db.normalizeId("others", id),
      }),
      call: mutationGeneric({
        args: { handle: v.string(), args: v.any() },
        handler: (ctx, { handle, args }) =>
          ctx.runMutation(handle as never, args as never).then(
            () => "returned",
            (error: unknown) => (error as Error).message,
          ),
      }),
    }),
};

/**
 * A child whose tables a fresh push numbers in name order, `alpha` before
 * `zeta`, whichever it declares first.
 */
const childSchema = defineSchema({
  zeta: defineTable({}),
  alpha: defineTable({}),
});

const childModules = {
  "_generated/server.ts": () => Promise.resolve({}),
};

/**
 * Each slot takes `{ doc }`, an id of the table it is named for.
 */
const slots: Readonly<Record<string, GenericValidator>> = {
  documents: v.object({ doc: v.id("documents") }),
  others: v.object({ doc: v.id("others") }),
};

const backend = () => {
  const t = convexTest({
    schema,
    modules,
    sources: inlineSources(modules),
    sink: {
      args: (slot) => slots[slot],
      returns: () => undefined,
      call: () => Promise.resolve(null),
    },
  });
  t.registerComponent("child", childSchema, childModules, {
    sources: inlineSources(childModules),
  });
  return t;
};

type Backend = ReturnType<typeof backend>;

const sent = (t: Backend, slot: string, doc: unknown) =>
  Effect.promise(() =>
    t.mutation("host:call" as never, {
      handle: `function://~sink;${slot}`,
      args: { doc },
    }),
  );

const foundIn = (id: string, table: string, validator: string) =>
  `ArgumentValidationError: Found ID "${id}" from table \`${table}\`, which does not match the table name in validator \`v.id("${validator}")\`.Path: .doc\n`;

describe("a sink slot's id check", () => {
  it.effect(
    "reads an id minted before a snapshot by its table after the restore",
    () =>
      Effect.gen(function* () {
        const source = backend();
        const id = yield* Effect.promise(() =>
          source.mutation("host:make" as never, {}),
        );
        const restored = backend();
        yield* Effect.promise(() =>
          restored.restoreSnapshot(source.exportSnapshot()),
        );
        const answer = yield* sent(restored, "documents", id);
        expect(answer).toBe(foundIn(id as string, "others", "documents"));
      }),
  );

  it.effect(
    "reads an id another session minted by the table it names, as the session's own id checks read it",
    () =>
      Effect.gen(function* () {
        const id = (yield* Effect.promise(() =>
          backend().mutation("host:make" as never, {}),
        )) as string;
        const other = backend();
        const normalized = yield* Effect.promise(() =>
          other.mutation("host:normalize" as never, { id }),
        );
        const asOthers = yield* sent(other, "others", id);
        const asDocuments = yield* sent(other, "documents", id);
        expect(normalized).toBe(id);
        expect(asOthers).toBe("returned");
        expect(asDocuments).toBe(foundIn(id, "others", "documents"));
      }),
  );

  // A boundary the testing guide states: the kernel numbers a component's
  // tables as a fresh push does. On a deployment that pushed `zeta` before it
  // added `alpha`, `zeta` keeps the first number and both answers swap, and a
  // dropped table's number stays taken.
  it.effect(
    "numbers a child's tables as a fresh push does, in name order, so its first table's id names the host's first table",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const [alpha, zeta] = (yield* Effect.promise(() =>
          t.runInComponent("child", (ctx: any) =>
            Promise.all([
              ctx.db.insert("alpha", {}),
              ctx.db.insert("zeta", {}),
            ]),
          ),
        )) as [string, string];
        const first = yield* sent(t, "documents", alpha);
        const second = yield* sent(t, "documents", zeta);
        expect(first).toBe("returned");
        expect(second).toBe(foundIn(zeta, "others", "documents"));
      }),
  );
});
