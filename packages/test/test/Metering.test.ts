// oxlint-disable effecttsgo/async-function -- Convex handlers and the kernel shim are Promise APIs, and these cases drive them directly.
import { assert, describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type TransactionMetrics,
} from "convex/server";
import { v, type GenericId } from "convex/values";
import { convexTest } from "../src/internal/ConvexTest";

// The binary's default ceilings and messages, from convex-backend at the
// local backend's pin (`precompiled-2026-10-28-cccbade`): `crates/common/src/knobs.rs`
// for the values, `crates/database/src/reads.rs:365-480`,
// `crates/database/src/writes.rs:241-310` and
// `crates/model/src/scheduled_jobs/mod.rs:162-196` for the messages.
const MiB = 1 << 20;
const help =
  "Consider using smaller limits in your queries, paginating your queries, or using indexed queries with a selective index range expressions.";

const schema = defineSchema({
  notes: defineTable({ text: v.string() }).index("by_text", ["text"]),
  stamps: defineTable({
    at: v.int64(),
    meta: v.optional(v.object({ at: v.int64() })),
  }),
});

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type Ctx = GenericMutationCtx<DataModel>;
type QueryCtx = GenericQueryCtx<DataModel>;
type Id = GenericId<"notes">;

const notes = {
  add: makeFunctionReference<"mutation", { text: string }, Id>("notes:add"),
  addTwo: makeFunctionReference<"mutation", {}, null>("notes:addTwo"),
  readWriteScheduleThenFail: makeFunctionReference<
    "mutation",
    { id: Id },
    null
  >("notes:readWriteScheduleThenFail"),
  readWrite: makeFunctionReference<"mutation", { id: Id }, null>(
    "notes:readWrite",
  ),
  measuredWrite: makeFunctionReference<
    "mutation",
    { id: Id },
    { read: number; written: number }
  >("notes:measuredWrite"),
  list: makeFunctionReference<"query", {}, Array<string>>("notes:list"),
  metrics: makeFunctionReference<"query", {}, TransactionMetrics>(
    "notes:metrics",
  ),
  ids: makeFunctionReference<"query", {}, Array<Id>>("notes:ids"),
};

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "notes.ts": () =>
    Promise.resolve({
      add: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) => ctx.db.insert("notes", { text }),
      }),
      addTwo: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          await ctx.db.insert("notes", { text: "first" });
          await ctx.db.insert("notes", { text: "second" });
          return null;
        },
      }),
      readWriteScheduleThenFail: mutationGeneric({
        args: { id: v.id("notes") },
        handler: async (ctx, { id }) => {
          await ctx.db.get(id);
          await ctx.db.insert("notes", { text: "dropped" });
          await ctx.scheduler.runAfter(60_000, notes.add, { text: "later" });
          throw new Error("The nested mutation failed.");
        },
      }),
      readWrite: mutationGeneric({
        args: { id: v.id("notes") },
        handler: async (ctx, { id }) => {
          await ctx.db.get(id);
          await ctx.db.insert("notes", { text: "merged" });
          return null;
        },
      }),
      measuredWrite: mutationGeneric({
        args: { id: v.id("notes") },
        handler: async (ctx, { id }) => {
          await ctx.db.get(id);
          await ctx.db.insert("notes", { text: "measured" });
          const metrics = await ctx.meta.getTransactionMetrics();
          return {
            read: metrics.documentsRead.used,
            written: metrics.documentsWritten.used,
          };
        },
      }),
      metrics: queryGeneric({
        args: {},
        handler: (ctx) => ctx.meta.getTransactionMetrics(),
      }),
      list: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("notes")
            .collect()
            .then((rows) => rows.map((row) => row.text)),
      }),
      ids: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("notes")
            .collect()
            .then((rows) => rows.map((row) => row._id)),
      }),
    }),
};

const world = () => convexTest(schema, modules);

const metricsOf = (ctx: Ctx): Promise<TransactionMetrics> =>
  ctx.meta.getTransactionMetrics();

const usedOf = (metrics: TransactionMetrics) =>
  Object.fromEntries(
    Object.entries(metrics).map(([metric, { used }]) => [metric, used]),
  );

/**
 * Run `step` for 0 through `count - 1`, each after the last settles, so the
 * call that crosses a limit is the last one made.
 */
const inOrder = (count: number, step: (i: number) => Promise<unknown>) =>
  Array.from({ length: count }, (_, i) => i).reduce<Promise<unknown>>(
    (previous, i) => previous.then(() => step(i)),
    Promise.resolve(),
  );

/**
 * Insert `count` notes, at most 16000 to a commit so no seed crosses the write
 * limit.
 */
const seed = (
  t: ReturnType<typeof world>,
  count: number,
  text: (i: number) => string = (i) => `note-${i}`,
) =>
  inOrder(Math.ceil(count / 16000), (batch) =>
    t.run((ctx: Ctx) =>
      inOrder(Math.min(16000, count - batch * 16000), (i) =>
        ctx.db.insert("notes", { text: text(batch * 16000 + i) }),
      ),
    ),
  );

/**
 * A text that makes a note exactly `bytes` in the binary's sizing: two
 * delimiters, `_id` with a 32-character ID, `_creationTime` and `text`.
 */
const textForNoteOf = (bytes: number) => "x".repeat(bytes - 70);

describe("getTransactionMetrics", () => {
  it("answers the binary's ceilings with nothing used in a fresh transaction", async () => {
    const t = world();
    const metrics = await t.run(metricsOf);
    expect(metrics).toEqual({
      bytesRead: { used: 0, remaining: 16 * MiB },
      bytesWritten: { used: 0, remaining: 16 * MiB },
      databaseQueries: { used: 0, remaining: 4096 },
      documentsRead: { used: 0, remaining: 32000 },
      documentsWritten: { used: 0, remaining: 16000 },
      functionsScheduled: { used: 0, remaining: 1000 },
      scheduledFunctionArgsBytes: { used: 0, remaining: 16 * MiB },
      filesWritten: { used: 0, remaining: 10 },
      fileWriteBytes: { used: 0, remaining: 16 * MiB },
      filesRead: { used: 0, remaining: 10 },
      fileReadBytes: { used: 0, remaining: 16 * MiB },
    });
  });

  it("answers inside a query, from the same counters", async () => {
    const t = world();
    await seed(t, 2);
    const metrics = await t.query(async (ctx: QueryCtx) => {
      await ctx.db.query("notes").collect();
      return ctx.meta.getTransactionMetrics();
    });
    expect(metrics.documentsRead.used).toBe(2);
    expect(metrics.databaseQueries.used).toBe(1);
    expect(metrics.documentsWritten.used).toBe(0);
  });
});

describe("limits", () => {
  it("documentsWritten: 16000 writes commit, the 16001st is refused", async () => {
    const t = world();
    const at = await t.run(async (ctx: Ctx) => {
      await inOrder(16000, () => ctx.db.insert("notes", { text: "w" }));
      return (await metricsOf(ctx)).documentsWritten;
    });
    expect(at).toEqual({ used: 16000, remaining: 0 });
    await expect(
      t.run((ctx: Ctx) =>
        inOrder(16001, () => ctx.db.insert("notes", { text: "w" })),
      ),
    ).rejects.toThrow(
      "Too many writes in a single function execution (limit: 16000)",
    );
  });

  it("bytesWritten: 16 MiB of writes commit, one byte more is refused", async () => {
    const t = world();
    const text = textForNoteOf(MiB);
    const at = await t.run(async (ctx: Ctx) => {
      await inOrder(16, () => ctx.db.insert("notes", { text }));
      return (await metricsOf(ctx)).bytesWritten;
    });
    expect(at).toEqual({ used: 16 * MiB, remaining: 0 });
    await expect(
      t.run(async (ctx: Ctx) => {
        await inOrder(15, () => ctx.db.insert("notes", { text }));
        await ctx.db.insert("notes", { text: textForNoteOf(MiB + 1) });
      }),
    ).rejects.toThrow(
      "Too many bytes written in a single function execution (limit: 16 MiB)",
    );
  });

  it("documentsRead: 32000 documents read, the 32001st is refused", async () => {
    const t = world();
    await seed(t, 32001);
    const at = await t.run(async (ctx: Ctx) => {
      await ctx.db.query("notes").take(32000);
      return (await metricsOf(ctx)).documentsRead;
    });
    expect(at).toEqual({ used: 32000, remaining: 0 });
    await expect(
      t.run((ctx: Ctx) => ctx.db.query("notes").collect()),
    ).rejects.toThrow(
      `Too many documents read in a single function execution (limit: 32000). ${help}`,
    );
  });

  it("bytesRead: 16 MiB read, one byte more is refused", async () => {
    const t = world();
    const text = textForNoteOf(MiB);
    await seed(t, 16, () => text);
    const at = await t.run(async (ctx: Ctx) => {
      await ctx.db.query("notes").collect();
      return (await metricsOf(ctx)).bytesRead;
    });
    expect(at).toEqual({ used: 16 * MiB, remaining: 0 });
    await t.run((ctx: Ctx) => ctx.db.insert("notes", { text: "" }));
    await expect(
      t.run((ctx: Ctx) => ctx.db.query("notes").collect()),
    ).rejects.toThrow(
      `Too many bytes read in a single function execution (limit: ${16 * MiB} bytes). ${help}`,
    );
  });

  it("databaseQueries: 4096 disjoint reads, the 4097th is refused", async () => {
    const t = world();
    await seed(t, 4097);
    const ids = await t.query(notes.ids, {});
    const at = await t.run(async (ctx: Ctx) => {
      await inOrder(4096, (i) => ctx.db.get(ids[i]!));
      return (await metricsOf(ctx)).databaseQueries;
    });
    expect(at).toEqual({ used: 4096, remaining: 0 });
    await expect(
      t.run((ctx: Ctx) => inOrder(ids.length, (i) => ctx.db.get(ids[i]!))),
    ).rejects.toThrow(
      `Too many reads in a single function execution (limit: 4096). ${help}`,
    );
  });

  it("functionsScheduled: 1000 schedules, the 1001st is refused", async () => {
    const t = world();
    const at = await t.run(async (ctx: Ctx) => {
      await inOrder(1000, () =>
        ctx.scheduler.runAfter(60_000, notes.add, { text: "s" }),
      );
      return (await metricsOf(ctx)).functionsScheduled;
    });
    expect(at).toEqual({ used: 1000, remaining: 0 });
    await expect(
      t.run((ctx: Ctx) =>
        inOrder(1001, () =>
          ctx.scheduler.runAfter(60_000, notes.add, { text: "s" }),
        ),
      ),
    ).rejects.toThrow(
      "Too many functions scheduled by this mutation (limit: 1000)",
    );
  });

  it("scheduledFunctionArgsBytes: 16 MiB of arguments, one byte more is refused", async () => {
    const t = world();
    // A schedule's arguments are sized as `[{ text }]`: 2 + 2 + 5 + 2 + length.
    const text = "x".repeat(8 * MiB - 11);
    const at = await t.run(async (ctx: Ctx) => {
      await ctx.scheduler.runAfter(60_000, notes.add, { text });
      await ctx.scheduler.runAfter(60_000, notes.add, { text });
      return (await metricsOf(ctx)).scheduledFunctionArgsBytes;
    });
    expect(at).toEqual({ used: 16 * MiB, remaining: 0 });
    await expect(
      t.run(async (ctx: Ctx) => {
        await ctx.scheduler.runAfter(60_000, notes.add, { text });
        await ctx.scheduler.runAfter(60_000, notes.add, { text: `${text}x` });
      }),
    ).rejects.toThrow(
      `Too large total size of the arguments of scheduled functions from this mutation (limit: ${16 * MiB} bytes)`,
    );
  });

  it("refuses inside the function, which can catch the error and go on", async () => {
    const t = world();
    const caught = await t.run(async (ctx: Ctx) => {
      await inOrder(1000, () =>
        ctx.scheduler.runAfter(60_000, notes.add, { text: "s" }),
      );
      const message = await ctx.scheduler
        .runAfter(60_000, notes.add, { text: "s" })
        .then(
          () => null,
          (error: Error) => error.message,
        );
      await ctx.db.insert("notes", { text: "after" });
      return message;
    });
    expect(caught).toBe(
      "Too many functions scheduled by this mutation (limit: 1000)",
    );
    expect(await t.query(notes.list, {})).toEqual(["after"]);
  });
});

describe("nested calls", () => {
  it("a failed nested mutation's writes drop from the count and its reads and schedules stay", async () => {
    const t = world();
    const id = await t.mutation(notes.add, { text: "seed" });
    const [before, after] = await t.run(async (ctx: Ctx) => {
      const first = usedOf(await metricsOf(ctx));
      await ctx
        .runMutation(notes.readWriteScheduleThenFail, { id })
        .catch(() => null);
      return [first, usedOf(await metricsOf(ctx))];
    });
    expect(before).toMatchObject({
      documentsRead: 0,
      documentsWritten: 0,
      functionsScheduled: 0,
      databaseQueries: 0,
    });
    // The read of `seed`, its interval, and the schedule stay with the
    // attempt; the insert went with the nested mutation.
    expect(after).toMatchObject({
      documentsRead: 1,
      documentsWritten: 0,
      bytesWritten: 0,
      functionsScheduled: 1,
      databaseQueries: 1,
    });
    expect(after["bytesRead"]).toBeGreaterThan(0);
  });

  it("a nested mutation that returns adds its writes to its caller's", async () => {
    const t = world();
    const id = await t.mutation(notes.add, { text: "seed" });
    const after = await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("notes", { text: "caller" });
      await ctx.runMutation(notes.readWrite, { id });
      return usedOf(await metricsOf(ctx));
    });
    expect(after).toMatchObject({
      documentsRead: 1,
      documentsWritten: 2,
      // The caller's insert put its ID in `by_id`, so the nested read of
      // `seed` drops the total by 1, saturating at 0, and adds back 2.
      databaseQueries: 2,
    });
  });

  it("a nested query's reads count in its caller, and a stale snapshot's do not", async () => {
    const t = world();
    await seed(t, 3);
    const [nested, stale] = await t.run(async (ctx: Ctx) => {
      await ctx.runQuery(notes.list, {});
      const afterNested = usedOf(await metricsOf(ctx));
      await ctx.runQuery(notes.list, {}, { useStaleSnapshot: true });
      return [afterNested, usedOf(await metricsOf(ctx))];
    });
    expect(nested).toMatchObject({ documentsRead: 3, databaseQueries: 1 });
    expect(stale).toEqual(nested);
  });

  it("a budget tightens only the nested call, from what the caller has used", async () => {
    const t = world();
    const [message, metrics] = await t.run(async (ctx: Ctx) => {
      await ctx.db.insert("notes", { text: "caller" });
      const refusal = await ctx
        .runMutation(
          notes.addTwo,
          {},
          { transactionLimits: { documentsWritten: 1 } },
        )
        .then(
          () => null,
          (error: Error) => error.message,
        );
      await ctx.db.insert("notes", { text: "caller again" });
      return [refusal, (await metricsOf(ctx)).documentsWritten];
    });
    // The caller had written 1, so the nested call's ceiling is 2.
    expect(message).toContain(
      "Too many writes in a single function execution (limit: 2)",
    );
    expect(metrics).toEqual({ used: 2, remaining: 16000 - 2 });
  });
});

describe("fix round 1", () => {
  it("a read that covers inserted IDs counts them, saturating as the binary does, and never goes below zero", async () => {
    const t = world();
    const counts = await t.run(async (ctx: Ctx) => {
      const ids: Array<Id> = [];
      await inOrder(100, () =>
        ctx.db.insert("notes", { text: "n" }).then((id) => ids.push(id)),
      );
      const afterInserts = (await metricsOf(ctx)).databaseQueries.used;
      await ctx.db.get(ids[0]!);
      const afterGet = (await metricsOf(ctx)).databaseQueries.used;
      await ctx.db.query("notes").withIndex("by_id").collect();
      const afterScan = (await metricsOf(ctx)).databaseQueries.used;
      return { afterInserts, afterGet, afterScan };
    });
    // The binary answers the same: 0 + its system share, then 100, then 1
    // (transactionControls.test.ts on the local backend).
    expect(counts).toEqual({ afterInserts: 0, afterGet: 100, afterScan: 1 });
  });

  it("a patch from a pending commit timestamp to the largest int64 is a write, at the top level and nested", async () => {
    const t = world();
    const result = await t.run(async (ctx: Ctx) => {
      // Convex 1.49 types an `int64` field as `bigint`. The placeholder is
      // what `vars.commitTs` writes into one.
      const pending = ctx.db.vars.commitTs as unknown as bigint;
      const top = await ctx.db.insert("stamps", { at: pending });
      await ctx.db.patch(top, { at: 9223372036854775807n });
      const nested = await ctx.db.insert("stamps", {
        at: 0n,
        meta: { at: pending },
      });
      await ctx.db.patch(nested, { meta: { at: 9223372036854775807n } });
      // A pending timestamp patched to a pending timestamp changes nothing.
      const same = await ctx.db.insert("stamps", { at: pending });
      await ctx.db.patch(same, { at: pending });
      const [topDoc, nestedDoc] = [
        await ctx.db.get(top),
        await ctx.db.get(nested),
      ];
      return {
        written: (await metricsOf(ctx)).documentsWritten.used,
        top: typeof topDoc!.at,
        nested: typeof nestedDoc!.meta!.at,
      };
    });
    expect(result).toEqual({ written: 5, top: "bigint", nested: "bigint" });
  });

  it("a stale-snapshot query starts with its caller's scheduling counters and no reads or writes", async () => {
    const t = world();
    await seed(t, 2);
    const inStale = await t.run(async (ctx: Ctx) => {
      await ctx.db.query("notes").collect();
      await ctx.db.insert("notes", { text: "written" });
      await ctx.scheduler.runAfter(60_000, notes.addTwo, {});
      return usedOf(
        await ctx.runQuery(notes.metrics, {}, { useStaleSnapshot: true }),
      );
    });
    // `[{}]` is 4 bytes.
    expect(inStale).toMatchObject({
      functionsScheduled: 1,
      scheduledFunctionArgsBytes: 4,
      documentsRead: 0,
      documentsWritten: 0,
      databaseQueries: 0,
    });
  });
});

describe("what counts", () => {
  it("counts disjoint intervals: one per document read by ID or per index range, merged when they overlap", async () => {
    const t = world();
    const [a, b] = [
      await t.mutation(notes.add, { text: "a" }),
      await t.mutation(notes.add, { text: "b" }),
    ];
    const used = await t.run(async (ctx: Ctx) => {
      await ctx.db.get(a);
      await ctx.db.get(a);
      await ctx.db.get(b);
      // Inserting registers the new ID, so reading it back adds no interval.
      const c = await ctx.db.insert("notes", { text: "c" });
      await ctx.db.get(c);
      await ctx.db
        .query("notes")
        .withIndex("by_text", (q) => q.eq("text", "a"))
        .collect();
      await ctx.db
        .query("notes")
        .withIndex("by_text", (q) => q.eq("text", "a"))
        .collect();
      await ctx.db
        .query("notes")
        .withIndex("by_text", (q) => q.gte("text", "a").lte("text", "b"))
        .collect();
      return usedOf(await metricsOf(ctx));
    });
    // by_id: a, b, then reading c drops the total by the index's 3 intervals,
    // saturating at 0, and adds back 3, the inserted c's among them. by_text:
    // ["a"] lies inside ["a", "b"], so one interval.
    expect(used["databaseQueries"]).toBe(4);
    // a, a, b by ID; c by ID; "a" twice by text; "a" and "b" in the range.
    expect(used["documentsRead"]).toBe(3 + 1 + 2 + 2);
  });

  it("a patch or replace that changes nothing reads the document and writes nothing", async () => {
    const t = world();
    const id = await t.mutation(notes.add, { text: "same" });
    const used = await t.run(async (ctx: Ctx) => {
      await ctx.db.patch(id, { text: "same" });
      await ctx.db.replace(id, { text: "same" });
      return usedOf(await metricsOf(ctx));
    });
    expect(used).toMatchObject({
      documentsRead: 2,
      documentsWritten: 0,
      bytesWritten: 0,
      databaseQueries: 1,
    });
  });

  it("each write counts, a delete with no bytes", async () => {
    const t = world();
    const used = await t.run(async (ctx: Ctx) => {
      const id = await ctx.db.insert("notes", { text: "x" });
      const inserted = (await metricsOf(ctx)).bytesWritten.used;
      await ctx.db.patch(id, { text: "y" });
      await ctx.db.delete(id);
      return { inserted, ...usedOf(await metricsOf(ctx)) };
    });
    // 2 + `_id` (3 + 1 + 34) + `_creationTime` (13 + 1 + 9) + `text` (4 + 1 + 3).
    expect(used.inserted).toBe(71);
    expect(used).toMatchObject({ documentsWritten: 3, bytesWritten: 71 * 2 });
  });

  it("a retried attempt counts from zero, not on top of the attempt it replaces", async () => {
    const t = world();
    const id = await t.mutation(notes.add, { text: "seed" });
    const held = await t.prepare(notes.measuredWrite, { id });
    expect(held.outcome).toEqual({
      _tag: "returned",
      value: { read: 1, written: 1 },
    });
    await t.run((ctx: Ctx) => ctx.db.patch(id, { text: "moved" }));
    const applied = await t.apply(held.id);
    assert(applied.kind === "conflict");
    expect(applied.next.number).toBe(2);
    expect(applied.next.outcome).toEqual({
      _tag: "returned",
      value: { read: 1, written: 1 },
    });
  });
});
