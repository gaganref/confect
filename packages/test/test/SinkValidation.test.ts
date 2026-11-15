import { describe, expect, it } from "@effect/vitest";
import { defineSchema, defineTable, mutationGeneric } from "convex/server";
import { v } from "convex/values";
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

const backend = () =>
  convexTest({
    schema,
    modules,
    sources: inlineSources(modules),
    sink: {
      args: () => v.object({ doc: v.id("documents") }),
      returns: () => undefined,
      call: () => Promise.resolve(null),
    },
  });

describe("a sink slot's id check after a restore", () => {
  it.effect(
    "reads an id minted before the snapshot by its table, as the session that minted it does",
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
        const message = yield* Effect.promise(() =>
          restored.mutation("host:call" as never, {
            handle: "function://~sink;slot",
            args: { doc: id },
          }),
        );
        expect(message).toBe(
          `ArgumentValidationError: Found ID "${id as string}" from table \`others\`, which does not match the table name in validator \`v.id("documents")\`.Path: .doc\n`,
        );
      }),
  );
});
