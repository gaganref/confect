import { DatabaseWriter as Writer, MiddlewareImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import schema from "../_generated/schema";
import {
  DatabaseReader,
  DatabaseWriter,
  MutationCtx,
} from "../_generated/services";
import { Changes, ObserveWrites } from "./ObserveWrites.spec";

export default MiddlewareImpl.make(
  schema,
  ObserveWrites,
  (effect, { invocation }) =>
    Effect.gen(function* () {
      const ctx = yield* MutationCtx;
      const raw = yield* DatabaseWriter;
      const reader = yield* DatabaseReader;
      const changes: Array<{ operation: string; count: number; sum: number }> =
        [];
      const writer = Writer.make(schema, ctx.db, (change) =>
        Effect.gen(function* () {
          if (change.tableName !== "demands") return;
          const total = yield* reader
            .table("totals")
            .index("by_creation_time")
            .first();
          if (Option.isNone(total)) return yield* Effect.die("missing total");
          const count =
            total.value.count +
            (change.newDoc === null ? 0 : 1) -
            (change.oldDoc === null ? 0 : 1);
          const sum =
            total.value.sum +
            (change.newDoc?.amount ?? 0) -
            (change.oldDoc?.amount ?? 0);
          yield* raw.table("totals").patch(total.value._id, { count, sum });
          changes.push({ operation: change.operation, count, sum });
          if ((invocation.args as { fail: boolean }).fail)
            return yield* Effect.die("hook refused write");
        }).pipe(Effect.orDie),
      );
      return yield* effect.pipe(
        Effect.provideService(DatabaseWriter, writer),
        Effect.provideService(Changes, changes),
      );
    }),
);
