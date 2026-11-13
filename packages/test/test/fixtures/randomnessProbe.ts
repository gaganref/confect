import * as Arr from "effect/Array";
import type {
  Sample,
  Use,
} from "../../../../tools/local-backend/fixtures/confect/groups/randomness.spec";
import * as Entropy from "../../src/internal/Entropy";

/**
 * One `Math.random` draw: a number in (0, 1). Exactly 0 would be a fake's, so
 * it fails.
 */
const draw = (value: ReadonlyArray<number>) =>
  value.length === 1 && value[0]! > 0 && value[0]! < 1
    ? "one draw in (0, 1)"
    : `not a draw: [${Arr.join(Arr.map(value, String), ", ")}]`;

/**
 * A 4-byte fill: four bytes, not all zero. A real fill is all zero once in 2^32
 * runs; a zero fill always is.
 */
const bytes = (value: ReadonlyArray<number>) =>
  value.length === 4 &&
  Arr.every(
    value,
    (byte) => Number.isInteger(byte) && byte >= 0 && byte < 256,
  ) &&
  Arr.some(value, (byte) => byte !== 0)
    ? "4 random bytes"
    : `not random bytes: [${Arr.join(Arr.map(value, String), ", ")}]`;

/**
 * The 65,536-byte fill: its length, kept, and whether it holds more than one
 * distinct byte. A zero or other constant fill holds one; any stream that is
 * not constant, a test's short cycle included, holds more.
 */
const spread = ([length, distinct]: ReadonlyArray<number>) => [
  length,
  distinct !== undefined && distinct > 1
    ? "not constant"
    : `constant: ${distinct}`,
];

/**
 * A use with only the values a target chooses replaced by what they must
 * satisfy. What both targets fix, a fill's or a UUID's length, the UUID's
 * version 4 layout, a digest or a refusal, is kept as it is.
 */
const outcome = (
  { permitted, name, message, value }: typeof Use.Type,
  chosen: (value: ReadonlyArray<number>) => unknown = (kept) => kept,
) => ({
  permitted,
  name,
  message,
  value: permitted ? chosen(value) : value,
});

export const normalize = (sample: typeof Sample.Type) => ({
  mathRandom: outcome(sample.mathRandom, draw),
  getRandomValues: outcome(sample.getRandomValues, bytes),
  largestFill: outcome(sample.largestFill, spread),
  oversizedFill: outcome(sample.oversizedFill),
  floatFill: outcome(sample.floatFill),
  detachedFill: outcome(sample.detachedFill, bytes),
  randomUUID: outcome(sample.randomUUID),
  generateKey: outcome(sample.generateKey),
  digest: outcome(sample.digest),
  loadMathRandom: outcome(sample.loadMathRandom, draw),
  loadGetRandomValues: outcome(sample.loadGetRandomValues, bytes),
  loadRandomUUID: outcome(sample.loadRandomUUID),
  loadGenerateKey: outcome(sample.loadGenerateKey),
});

const permitted = (value: unknown) => ({
  permitted: true,
  name: null,
  message: null,
  value,
});

const refused = (name: string, message: string) => ({
  permitted: false,
  name,
  message,
  value: [],
});

const noCryptoRng = refused("Error", Entropy.noCryptoRngInQueriesOrMutations);

/**
 * SHA-256 of the bytes 1, 2, 3.
 */
const digest = [
  3, 144, 88, 198, 242, 192, 203, 73, 44, 83, 59, 10, 77, 20, 239, 119, 204, 15,
  120, 171, 204, 206, 213, 40, 125, 132, 161, 162, 1, 28, 251, 129,
];

/**
 * What the binary answers in a query and a mutation (convex-backend
 * `cccbade4`). Every random source draws from the function's seeded generator
 * (`crates/isolate/src/ops/random.rs:7-11`, `ops/crypto.rs:8-31`), and
 * `randomUUID` builds a version 4 UUID from it (`ops/crypto.rs:8-12`).
 * `getRandomValues` refuses more than 65,536 bytes with a `TypeError`
 * (`ops/crypto.rs:22-29`) and a non-integer array with a `TypeMismatchError`
 * (`npm-packages/udf-runtime/src/00_crypto.ts:31-36`). It never reads its
 * receiver, so a detached call draws as an attached one does
 * (`00_crypto.ts:28-53`). A module may draw while it loads, from a generator
 * seeded once per push (`crates/isolate/src/environment/udf/phase.rs:186-193`,
 * `environment/analyze.rs:284`); only a module deployed without that seed
 * refuses with `NoRandomDuringImport` (`udf/phase.rs:500-507`). Cryptographic
 * randomness, `crypto.subtle.generateKey` here, is refused in a query or a
 * mutation and while a module loads for one (`environment/udf/mod.rs:264-272`,
 * `:290-292`). A digest is deterministic.
 */
const transaction = {
  mathRandom: permitted("one draw in (0, 1)"),
  getRandomValues: permitted("4 random bytes"),
  largestFill: permitted([65_536, "not constant"]),
  oversizedFill: refused(
    "TypeError",
    "Byte length (65537) exceeds the number of bytes of entropy available via this API (65536)",
  ),
  floatFill: refused(
    "TypeMismatchError",
    "The provided ArrayBufferView is not an integer array type",
  ),
  detachedFill: permitted("4 random bytes"),
  randomUUID: permitted([36, 1]),
  generateKey: noCryptoRng,
  digest: permitted(digest),
  loadMathRandom: permitted("one draw in (0, 1)"),
  loadGetRandomValues: permitted("4 random bytes"),
  loadRandomUUID: permitted([36, 1]),
  loadGenerateKey: noCryptoRng,
};

/**
 * What the binary answers in an action: the same, except that an action's
 * `CryptoRng` is the system's (`environment/action/mod.rs:1576-1578`), so it
 * generates a key, at run time and while a module loads for it.
 */
const binaryAction = {
  ...transaction,
  generateKey: permitted([1]),
  loadGenerateKey: permitted([1]),
};

export const expected = {
  query: transaction,
  mutation: transaction,
  action: binaryAction,
};

/**
 * What the kernel answers: the binary's, apart from the two conformance entries
 * `ActionCryptoRandomness` and `ActionLoadCryptoRandomness` in
 * `packages/server/test/mock-backend/kernelBoundaries.ts`. The kernel cannot
 * seed an action's cryptographic randomness, so it refuses it with
 * `RequiresBinary`. It loads each module once for every function type, under
 * the queries' and mutations' rule.
 */
export const expectedOnKernel = {
  query: transaction,
  mutation: transaction,
  action: {
    ...transaction,
    generateKey: (() => {
      const refusal = Entropy.subtleRefusal("action", "generateKey");
      return refused(refusal.name, refusal.message);
    })(),
  },
};
