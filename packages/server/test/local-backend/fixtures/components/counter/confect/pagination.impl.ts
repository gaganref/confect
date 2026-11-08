import {
  DatabaseWriter as Writer,
  type DataModel,
  MutationCtx as RawMutationCtx,
  FunctionImpl,
  GroupImpl,
  QueryStream,
} from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { DatabaseReader } from "./_generated/services";
import type { scope } from "./_generated/id";
import spec from "./pagination.spec";

const MutationCtx = RawMutationCtx.MutationCtx<
  DataModel.ToConvex<DataModel.FromSchema<typeof schema>>,
  typeof scope
>();

const page = FunctionImpl.make(
  schema,
  spec,
  "page",
  ({ run, cursor, numItems }) =>
    Effect.gen(function* () {
      const reader = yield* DatabaseReader;
      return yield* reader
        .table("counters")
        .index("by_run_count", (q) => q.eq("run", run))
        .paginate({ cursor, numItems });
    }).pipe(Effect.orDie),
);

const streams = FunctionImpl.make(schema, spec, "streams", ({ run }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const source = reader
      .table("counters")
      .stream("by_run_count", (q) => q.eq("run", run));
    const deferred = QueryStream.defer(
      { keyLayout: source.keyLayout, orderDirection: source.orderDirection },
      Effect.succeed(source),
    );
    const collected = yield* QueryStream.collect(deferred);
    const merged = yield* QueryStream.collect(
      QueryStream.merge([source, source], { dedupe: true }),
    );
    const oversized = QueryStream.flatMap(source, () => source, {
      innerKeyLayout: source.keyLayout,
    });
    const budget = yield* QueryStream.collect(oversized).pipe(
      Effect.map(() => -1),
      Effect.catchTag("ReadBudgetExceededError", (e) =>
        Effect.succeed(e.rowsRead),
      ),
    );
    return {
      deferred: collected.map((d) => d.count),
      merged: merged.map((d) => d.count),
      budget,
    };
  }).pipe(Effect.orDie),
);

const hook = FunctionImpl.make(schema, spec, "hook", ({ run }) =>
  Effect.gen(function* () {
    const ctx = yield* MutationCtx;
    const changes: Array<{ operation: string; count: number }> = [];
    const writer = Writer.make(
      schema,
      ctx.db as unknown as Parameters<typeof Writer.make<typeof schema>>[1],
      (change) =>
        Effect.sync(() => {
          if (change.tableName !== "counters") return;
          changes.push({
            operation: change.operation,
            count: (change.newDoc ?? change.oldDoc).count,
          });
        }),
    );
    const table = writer.table("counters");
    const id = yield* table.insert({ run, count: 1 });
    yield* table.patch(id, { count: 2 });
    yield* table.delete(id);
    return changes;
  }).pipe(Effect.orDie),
);

const searchPage = FunctionImpl.make(
  schema,
  spec,
  "searchPage",
  ({ run, cursor, numItems }) =>
    Effect.gen(function* () {
      const reader = yield* DatabaseReader;
      return yield* reader
        .table("counters")
        .search("search_run", (q) => q.search("run", run))
        .paginate({ cursor, numItems });
    }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([page, searchPage, streams, hook]),
  GroupImpl.finalize,
);
