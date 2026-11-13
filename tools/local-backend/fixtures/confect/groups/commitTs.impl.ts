import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import { DatabaseReader, DatabaseWriter } from "../_generated/services";
import commitTs from "./commitTs.spec";
import * as Array from "effect/Array";

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
      return Array.map(stamps, ({ label, at }) => ({ label, at }));
    }).pipe(Effect.orDie),
);

export default GroupImpl.make(databaseSchema, commitTs).pipe(
  Layer.provide(stamp),
  Layer.provide(newestFirst),
  GroupImpl.finalize,
);
