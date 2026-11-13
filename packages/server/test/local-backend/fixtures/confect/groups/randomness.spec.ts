import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

/**
 * One use of a random source: whether the backend let it run, the error it
 * threw if not, and what it produced if so.
 */
export const Use = Schema.Struct({
  permitted: Schema.Boolean,
  name: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  value: Schema.Array(Schema.Finite),
});

/**
 * Every random source a function may reach, each tried once in this order.
 */
export const Sample = Schema.Struct({
  mathRandom: Use,
  getRandomValues: Use,
  largestFill: Use,
  oversizedFill: Use,
  floatFill: Use,
  detachedFill: Use,
  randomUUID: Use,
});

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicQuery({ name: "query", returns: () => Sample }),
  )
  .addFunction(
    FunctionSpec.publicMutation({ name: "mutation", returns: () => Sample }),
  )
  .addFunction(
    FunctionSpec.publicAction({ name: "action", returns: () => Sample }),
  );
