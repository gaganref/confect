import type {
  Sample,
  Use,
} from "../../../server/test/local-backend/fixtures/confect/groups/randomness.spec";

/**
 * A use without the values it drew, which only the kernel's supplied stream
 * fixes: whether it ran, its error if not, and how many values it produced.
 */
const outcome = ({ permitted, name, message, value }: typeof Use.Type) => ({
  permitted,
  name,
  message,
  size: value.length,
});

export const normalize = (sample: typeof Sample.Type) => ({
  mathRandom: outcome(sample.mathRandom),
  getRandomValues: outcome(sample.getRandomValues),
  largestFill: outcome(sample.largestFill),
  oversizedFill: outcome(sample.oversizedFill),
  floatFill: outcome(sample.floatFill),
  detachedFill: outcome(sample.detachedFill),
  randomUUID: outcome(sample.randomUUID),
  loadMathRandom: outcome(sample.loadMathRandom),
  loadGetRandomValues: outcome(sample.loadGetRandomValues),
});

const permitted = (size: number) => ({
  permitted: true,
  name: null,
  message: null,
  size,
});

/**
 * What the binary answers in a query, a mutation and an action alike
 * (convex-backend `cccbade4`). Every random source draws from the function's
 * seeded generator (`crates/isolate/src/ops/random.rs:7-11`,
 * `ops/crypto.rs:8-31`). `getRandomValues` refuses more than 65,536 bytes with
 * a `TypeError` (`ops/crypto.rs:22-29`) and a non-integer array with a
 * `TypeMismatchError` (`npm-packages/udf-runtime/src/00_crypto.ts:31-36`). It
 * never reads its receiver, so a detached call draws as an attached one does
 * (`00_crypto.ts:28-53`). A module may draw while it loads, from a generator
 * seeded once per push (`crates/isolate/src/environment/udf/phase.rs:186-193`,
 * `environment/analyze.rs:284`); only a module deployed without that seed
 * refuses with `NoRandomDuringImport` (`udf/phase.rs:500-507`).
 */
const sample = {
  mathRandom: permitted(1),
  getRandomValues: permitted(4),
  largestFill: permitted(1),
  oversizedFill: {
    permitted: false,
    name: "TypeError",
    message:
      "Byte length (65537) exceeds the number of bytes of entropy available via this API (65536)",
    size: 0,
  },
  floatFill: {
    permitted: false,
    name: "TypeMismatchError",
    message: "The provided ArrayBufferView is not an integer array type",
    size: 0,
  },
  detachedFill: permitted(1),
  randomUUID: permitted(1),
  loadMathRandom: permitted(1),
  loadGetRandomValues: permitted(4),
};

export const expected = { query: sample, mutation: sample, action: sample };
