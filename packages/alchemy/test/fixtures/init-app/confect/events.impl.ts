import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { DatabaseWriter } from "./_generated/services";
import args from "./args";
import events from "./events.spec";

const insert = (event: { fromName: string; message: string }) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    yield* writer.table("events").insert(event);
    return null;
  }).pipe(Effect.orDie);

const record = FunctionImpl.make(schema, events, "record", insert);

export default GroupImpl.make(schema, events).pipe(
  Layer.provide(
    args.withGone
      ? [record, FunctionImpl.make(schema, events, "gone", insert)]
      : [record],
  ),
  GroupImpl.finalize,
);
