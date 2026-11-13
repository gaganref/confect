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
      return notes.map((note) => note.value);
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
      if (fail) return yield* new RejectedWrite({ value });
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
 * One fixed workload, the same on every target: writes, a write that changes
 * nothing, a delete, reads by ID and by index, nested reads, a nested mutation
 * that fails and one that commits, and a schedule. It answers the transaction's
 * metrics before and after it. A nested call into this module comes first, so
 * the binary has read the system tables it needs to run one before `start`.
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
      yield* queries.runQuery(refs.internal.groups.transactions.read, {
        caseId: `${caseId}-warm`,
      });
      const start = yield* transaction.getMetrics();
      const notes = writer.table("transactionNotes");
      const kept = yield* notes.insert({ caseId, value: "kept" });
      const same = yield* notes.insert({ caseId, value: "same" });
      const gone = yield* notes.insert({ caseId, value: "gone" });
      yield* reader.table("transactionNotes").get(gone);
      yield* notes.patch(kept, { value: "patched" });
      yield* notes.patch(same, { value: "same" });
      yield* notes.delete(gone);
      yield* reader
        .table("transactionNotes")
        .index("by_caseId", (q) => q.eq("caseId", caseId))
        .collect();
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
      yield* scheduler.runAfter(
        Duration.hours(1),
        refs.internal.groups.transactions.write,
        { caseId: `${caseId}-later`, value: "scheduled", fail: false },
      );
      return { start, end: yield* transaction.getMetrics() };
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
  GroupImpl.finalize,
);
