import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import schema from "./_generated/schema";
import {
  DatabaseReader,
  DatabaseWriter,
  MutationRunner,
} from "./_generated/services";
import install from "./install.spec";

const current = Effect.flatMap(DatabaseReader, (reader) =>
  reader.table("settings").index("by_creation_time").first(),
);

// The author's config store: one row, replaced on every push, so an omitted
// optional arg drops its field.
const init = FunctionImpl.make(schema, install, "init", (args) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    const row = yield* current;
    if (Option.isSome(row))
      yield* writer.table("settings").replace(row.value._id, args);
    else yield* writer.table("settings").insert(args);
    if (args.fromName.startsWith("FAIL"))
      return yield* Effect.die(new Error("SyntheticInitAfterWrite"));
    return null;
  }).pipe(Effect.orDie),
);

const settings = FunctionImpl.make(schema, install, "settings", () =>
  current.pipe(Effect.map(Option.getOrNull), Effect.orDie),
);

const send = FunctionImpl.make(schema, install, "send", ({ message }) =>
  Effect.gen(function* () {
    const runner = yield* MutationRunner;
    const { fromName, onEvent } = Option.getOrThrow(yield* current);
    if (onEvent !== undefined)
      yield* runner.runMutation(onEvent, { fromName, message });
    return null;
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, install).pipe(
  Layer.provide([init, settings, send]),
  GroupImpl.finalize,
);
