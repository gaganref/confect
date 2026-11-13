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
 * Every random source a function may reach, each tried once in this order, then
 * what the module drew while it loaded. Each use records:
 *
 * - `mathRandom`, `loadMathRandom`: the draw.
 * - `getRandomValues`, `detachedFill`, `loadGetRandomValues`: the 4 bytes.
 * - `largestFill`: the fill's length and how many distinct bytes it holds.
 * - `oversizedFill`, `floatFill`: the fill's length, if it ran.
 * - `randomUUID`, `loadRandomUUID`: the UUID's length, and 1 if it has the
 *   version 4 layout.
 * - `generateKey`, `loadGenerateKey`: 1 if an HMAC key was generated.
 * - `digest`: the SHA-256 of the bytes 1, 2, 3.
 */
export const Sample = Schema.Struct({
  mathRandom: Use,
  getRandomValues: Use,
  largestFill: Use,
  oversizedFill: Use,
  floatFill: Use,
  detachedFill: Use,
  randomUUID: Use,
  generateKey: Use,
  digest: Use,
  loadMathRandom: Use,
  loadGetRandomValues: Use,
  loadRandomUUID: Use,
  loadGenerateKey: Use,
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
