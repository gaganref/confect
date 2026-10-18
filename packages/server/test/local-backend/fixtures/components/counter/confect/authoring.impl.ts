import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { DatabaseReader, DatabaseWriter } from "./_generated/services";
import spec, { ClassProbe } from "./authoring.spec";

const save = FunctionImpl.make(schema, spec, "save", (ids) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    return yield* writer.table("systemIds").insert(ids);
  }).pipe(Effect.orDie),
);

const read = FunctionImpl.make(schema, spec, "read", ({ id }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    return yield* reader.table("systemIds").get(id);
  }).pipe(Effect.orDie),
);

const probe = FunctionImpl.make(schema, spec, "probe", ({ value }) =>
  Effect.succeed(new ClassProbe({ value })),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([save, read, probe]),
  GroupImpl.finalize,
);
