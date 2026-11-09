import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { DatabaseReader, DatabaseWriter } from "./_generated/services";
import args from "./args";
import events from "./events.spec";

const insert = (event: { fromName: string; message: string }) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    yield* writer.table("events").insert(event);
    return null;
  }).pipe(Effect.orDie);

const record = FunctionImpl.make(schema, events, "record", insert);

const list = FunctionImpl.make(schema, events, "list", () =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    return yield* reader.table("events").index("by_creation_time").collect();
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, events).pipe(
  Layer.provide(
    args.withGone
      ? [record, list, FunctionImpl.make(schema, events, "gone", insert)]
      : [record, list],
  ),
  GroupImpl.finalize,
);
