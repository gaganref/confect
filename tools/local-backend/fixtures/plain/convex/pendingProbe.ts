// Hand-written: compares the shared validator check with the binary's own on a
// pending commit timestamp, which a Confect function's Effect encoding never
// hands to an int64 or literal validator.
import * as ValidatorCheck from "@confect/core/ValidatorCheck";
import { mutationGeneric } from "convex/server";
import { type GenericValidator, v } from "convex/values";
import * as Rec from "effect/Record";

const kinds: Readonly<Record<string, GenericValidator>> = {
  int64: v.int64(),
  float64: v.float64(),
  max: v.literal(9223372036854775807n),
  zero: v.literal(0n),
  commitTs: v.commitTs(),
  any: v.any(),
};

const lookups: ValidatorCheck.Lookups = {
  tableOf: () => undefined,
  isFunctionHandle: () => false,
};

const binary = (validator: GenericValidator) =>
  mutationGeneric({
    args: {},
    returns: v.object({ ts: validator }),
    handler: (ctx) => Promise.resolve({ ts: ctx.db.vars.commitTs }),
  });

export const binaryInt64 = binary(kinds.int64!);
export const binaryFloat64 = binary(kinds.float64!);
export const binaryMax = binary(kinds.max!);
export const binaryZero = binary(kinds.zero!);
export const binaryCommitTs = binary(kinds.commitTs!);
export const binaryAny = binary(kinds.any!);

/**
 * What the shared check answers for a pending timestamp under each kind.
 */
export const confect = mutationGeneric({
  args: {},
  handler: (ctx) =>
    Promise.resolve(
      Rec.map(
        kinds,
        (validator) =>
          ValidatorCheck.check(
            v.object({ ts: validator }),
            { ts: ctx.db.vars.commitTs },
            lookups,
          ) === undefined,
      ),
    ),
});
