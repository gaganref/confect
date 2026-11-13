import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema.js";
import { MutationRunner } from "./_generated/services.js";
import spec from "./counter.spec.js";
const increment = FunctionImpl.make(schema, spec, "increment", ({ value }) =>
  Effect.succeed(value + 1),
);
const notify = FunctionImpl.make(
  schema,
  spec,
  "notify",
  ({ value, onResult }) =>
    Effect.gen(function* () {
      const runner = yield* MutationRunner;
      const result = yield* runner.runMutation(onResult, { value });
      return result + 1;
    }).pipe(Effect.orDie),
);
export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([increment, notify]),
  GroupImpl.finalize,
);
