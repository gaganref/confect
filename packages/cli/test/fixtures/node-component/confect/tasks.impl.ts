import { DatabaseSchema, FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import tasks from "./tasks.spec";

const schema = DatabaseSchema.make({});

const run = FunctionImpl.make(schema, tasks, "run", () =>
  Effect.succeed("done"),
);

export default GroupImpl.make(schema, tasks).pipe(
  Layer.provide(run),
  GroupImpl.finalize,
);
