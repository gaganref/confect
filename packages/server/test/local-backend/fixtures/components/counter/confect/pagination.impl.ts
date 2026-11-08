import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { DatabaseReader } from "./_generated/services";
import spec from "./pagination.spec";

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
  Layer.provide([page, searchPage]),
  GroupImpl.finalize,
);
