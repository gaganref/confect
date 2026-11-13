import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import {
  DatabaseReader,
  DatabaseWriter,
  TransactionMetadata,
} from "../_generated/services";
import commitTs from "./commitTs.spec";

const stamp = FunctionImpl.make(
  databaseSchema,
  commitTs,
  "stamp",
  ({ caseId, label }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      const reader = yield* DatabaseReader;
      const id = yield* writer
        .table("commitStamps")
        .insert({ caseId, label, at: writer.vars.commitTs });
      const { at } = yield* reader.table("commitStamps").get(id);
      return typeof at === "bigint" ? "bigint" : "placeholder";
    }).pipe(Effect.orDie),
);

/**
 * A pending commit timestamp patched to the largest int64 is a write: the
 * binary compares pending values structurally, so the two are not equal.
 */
const maxAfterPending = FunctionImpl.make(
  databaseSchema,
  commitTs,
  "maxAfterPending",
  ({ caseId }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      const reader = yield* DatabaseReader;
      const transaction = yield* TransactionMetadata;
      const id = yield* writer
        .table("commitStamps")
        .insert({ caseId, label: "max", at: writer.vars.commitTs });
      yield* writer
        .table("commitStamps")
        .patch(id, { at: 9223372036854775807n });
      const { at } = yield* reader.table("commitStamps").get(id);
      const metrics = yield* transaction.getMetrics();
      return {
        written: metrics.documentsWritten.used,
        stored:
          typeof at === "bigint"
            ? ("bigint" as const)
            : ("placeholder" as const),
        value: String(at),
      };
    }).pipe(Effect.orDie),
);

const newestFirst = FunctionImpl.make(
  databaseSchema,
  commitTs,
  "newestFirst",
  ({ caseId }) =>
    Effect.gen(function* () {
      const reader = yield* DatabaseReader;
      const stamps = yield* reader
        .table("commitStamps")
        .index("by_caseId_at", (q) => q.eq("caseId", caseId), "desc")
        .collect();
      return stamps.map(({ label, at }) => ({ label, at }));
    }).pipe(Effect.orDie),
);

export default GroupImpl.make(databaseSchema, commitTs).pipe(
  Layer.provide(stamp),
  Layer.provide(maxAfterPending),
  Layer.provide(newestFirst),
  GroupImpl.finalize,
);
