import * as Arr from "effect/Array";
import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import refs from "../_generated/refs";
import {
  DatabaseReader,
  DatabaseWriter,
  MutationRunner,
  QueryRunner,
  Scheduler,
  TransactionMetadata,
} from "../_generated/services";
import transactions, { RejectedWrite } from "./transactions.spec";

const read = FunctionImpl.make(
  databaseSchema,
  transactions,
  "read",
  ({ caseId }) =>
    Effect.gen(function* () {
      const reader = yield* DatabaseReader;
      const notes = yield* reader
        .table("transactionNotes")
        .index("by_caseId", (q) => q.eq("caseId", caseId))
        .collect();
      return Arr.map(notes, (note) => note.value);
    }).pipe(Effect.orDie),
);

const write = FunctionImpl.make(
  databaseSchema,
  transactions,
  "write",
  ({ caseId, value, fail }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      yield* writer
        .table("transactionNotes")
        .insert({ caseId, value })
        .pipe(Effect.orDie);
      if (fail) return yield* RejectedWrite.make({ value });
      return null;
    }),
);

const seed = FunctionImpl.make(
  databaseSchema,
  transactions,
  "seed",
  ({ caseId, count }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      const reader = yield* DatabaseReader;
      const notes = yield* reader
        .table("transactionNotes")
        .index("by_caseId", (q) => q.eq("caseId", caseId))
        .collect();
      for (const note of notes)
        yield* writer.table("transactionNotes").delete(note._id);
      for (let i = 0; i < count; i++) {
        yield* writer
          .table("transactionNotes")
          .insert({ caseId, value: `seed-${i}` });
      }
      return null;
    }).pipe(Effect.orDie),
);

const limitedRead = FunctionImpl.make(
  databaseSchema,
  transactions,
  "limitedRead",
  ({ caseId, limit }) =>
    Effect.gen(function* () {
      const queries = yield* QueryRunner;
      return yield* queries.runQuery(
        refs.internal.groups.transactions.read,
        { caseId },
        {
          transactionLimits: { documentsRead: limit },
        },
      );
    }).pipe(Effect.orDie),
);

const limitedReadFromMutation = FunctionImpl.make(
  databaseSchema,
  transactions,
  "limitedReadFromMutation",
  ({ caseId, limit }) =>
    Effect.gen(function* () {
      const queries = yield* QueryRunner;
      return yield* queries.runQuery(
        refs.internal.groups.transactions.read,
        { caseId },
        {
          transactionLimits: { documentsRead: limit },
        },
      );
    }).pipe(Effect.orDie),
);

const limitedWrite = FunctionImpl.make(
  databaseSchema,
  transactions,
  "limitedWrite",
  ({ caseId, limit }) =>
    Effect.gen(function* () {
      const mutations = yield* MutationRunner;
      return yield* mutations.runMutation(
        refs.internal.groups.transactions.write,
        { caseId, value: "child", fail: false },
        {
          transactionLimits: { documentsWritten: limit },
        },
      );
    }).pipe(Effect.orDie),
);

const rollback = FunctionImpl.make(
  databaseSchema,
  transactions,
  "rollback",
  ({ caseId }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      yield* writer
        .table("transactionNotes")
        .insert({ caseId, value: "parent" });
      const mutations = yield* MutationRunner;
      return yield* mutations
        .runMutation(
          refs.internal.groups.transactions.write,
          { caseId, value: "child", fail: true },
          {
            transactionLimits: { documentsWritten: 10 },
          },
        )
        .pipe(
          Effect.as(false),
          Effect.catchTag("RejectedWrite", () => Effect.succeed(true)),
        );
    }).pipe(Effect.orDie),
);

const staleRead = FunctionImpl.make(
  databaseSchema,
  transactions,
  "staleRead",
  ({ caseId, stale }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      yield* writer
        .table("transactionNotes")
        .insert({ caseId, value: "uncommitted" });
      const queries = yield* QueryRunner;
      return yield* queries.runQuery(
        refs.internal.groups.transactions.read,
        { caseId },
        {
          useStaleSnapshot: stale,
          transactionLimits: { documentsRead: 10 },
        },
      );
    }).pipe(Effect.orDie),
);

/**
 * One fixed workload, the same on every target, over three notes `seed` wrote
 * for `caseId` beforehand: an index read, a read by ID, a write, a write that
 * changes nothing, a delete, a nested query, a nested mutation that fails and
 * one that commits, an insert and a schedule. Every read by ID comes before the
 * first insert, so no read covers an inserted ID. It answers the transaction's
 * metrics before and after.
 */
const metrics = FunctionImpl.make(
  databaseSchema,
  transactions,
  "metrics",
  ({ caseId }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      const reader = yield* DatabaseReader;
      const queries = yield* QueryRunner;
      const mutations = yield* MutationRunner;
      const scheduler = yield* Scheduler;
      const transaction = yield* TransactionMetadata;
      const start = yield* transaction.getMetrics();
      const notes = writer.table("transactionNotes");
      const [first, second, third] = yield* reader
        .table("transactionNotes")
        .index("by_caseId", (q) => q.eq("caseId", caseId))
        .collect();
      yield* reader.table("transactionNotes").get(first!._id);
      yield* notes.patch(second!._id, { value: "patched" });
      yield* notes.patch(third!._id, { value: third!.value });
      yield* notes.delete(first!._id);
      yield* queries.runQuery(refs.internal.groups.transactions.read, {
        caseId,
      });
      yield* mutations
        .runMutation(refs.internal.groups.transactions.write, {
          caseId,
          value: "dropped",
          fail: true,
        })
        .pipe(Effect.catchTag("RejectedWrite", () => Effect.void));
      yield* mutations.runMutation(refs.internal.groups.transactions.write, {
        caseId,
        value: "nested",
        fail: false,
      });
      yield* notes.insert({ caseId, value: "kept" });
      yield* scheduler.runAfter(
        Duration.hours(1),
        refs.internal.groups.transactions.write,
        { caseId: `${caseId}-later`, value: "scheduled", fail: false },
      );
      return { start, end: yield* transaction.getMetrics() };
    }).pipe(Effect.orDie),
);

/**
 * `count` inserts, then a read of the first inserted ID, then a scan of the
 * table's `by_id` index, with `databaseQueries` after each. Inserted IDs join
 * the read set without counting, so the read and the scan move the count by the
 * binary's saturating rule.
 */
const insertedIntervals = FunctionImpl.make(
  databaseSchema,
  transactions,
  "insertedIntervals",
  ({ caseId, count }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      const reader = yield* DatabaseReader;
      const transaction = yield* TransactionMetadata;
      const queries = () =>
        transaction
          .getMetrics()
          .pipe(Effect.map((current) => current.databaseQueries.used));
      const ids = [];
      for (let i = 0; i < count; i++) {
        const id = yield* writer
          .table("transactionNotes")
          .insert({ caseId, value: `inserted-${i}` });
        ids.push(id);
      }
      const afterInserts = yield* queries();
      yield* reader.table("transactionNotes").get(ids[0]!);
      const afterGet = yield* queries();
      yield* reader.table("transactionNotes").index("by_id").collect();
      const afterScan = yield* queries();
      return { afterInserts, afterGet, afterScan };
    }).pipe(Effect.orDie),
);

const idle = FunctionImpl.make(databaseSchema, transactions, "idle", () =>
  Effect.succeed(null),
);

const readMetrics = FunctionImpl.make(
  databaseSchema,
  transactions,
  "readMetrics",
  () =>
    Effect.gen(function* () {
      const transaction = yield* TransactionMetadata;
      return yield* transaction.getMetrics();
    }),
);

/**
 * Schedule once, then read the metrics inside a stale-snapshot query, which the
 * binary runs on a clone that keeps the scheduling counters.
 */
const staleMetrics = FunctionImpl.make(
  databaseSchema,
  transactions,
  "staleMetrics",
  () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const queries = yield* QueryRunner;
      yield* scheduler.runAfter(
        Duration.hours(1),
        refs.internal.groups.transactions.idle,
        {},
      );
      return yield* queries.runQuery(
        refs.internal.groups.transactions.readMetrics,
        {},
        { useStaleSnapshot: true },
      );
    }).pipe(Effect.orDie),
);

/**
 * The system-table read intervals the binary counts in `databaseQueries` to run
 * a function, measured with no user table touched: a root mutation's count at
 * its start, what its first nested call adds, and a stale-snapshot query's
 * count at its start. The test kernel counts only a function's own reads, so it
 * answers 0 for each.
 */
const systemShare = FunctionImpl.make(
  databaseSchema,
  transactions,
  "systemShare",
  () =>
    Effect.gen(function* () {
      const transaction = yield* TransactionMetadata;
      const queries = yield* QueryRunner;
      const start = yield* transaction.getMetrics();
      yield* queries.runQuery(
        refs.internal.groups.transactions.readMetrics,
        {},
      );
      const afterNested = yield* transaction.getMetrics();
      const stale = yield* queries.runQuery(
        refs.internal.groups.transactions.readMetrics,
        {},
        { useStaleSnapshot: true },
      );
      return {
        root: start.databaseQueries.used,
        nested: afterNested.databaseQueries.used - start.databaseQueries.used,
        stale: stale.databaseQueries!.used,
      };
    }).pipe(Effect.orDie),
);

export default GroupImpl.make(databaseSchema, transactions).pipe(
  Layer.provide(read),
  Layer.provide(write),
  Layer.provide(seed),
  Layer.provide(limitedRead),
  Layer.provide(limitedReadFromMutation),
  Layer.provide(limitedWrite),
  Layer.provide(rollback),
  Layer.provide(staleRead),
  Layer.provide(metrics),
  Layer.provide(systemShare),
  Layer.provide(insertedIntervals),
  Layer.provide(idle),
  Layer.provide(readMetrics),
  Layer.provide(staleMetrics),
  GroupImpl.finalize,
);
