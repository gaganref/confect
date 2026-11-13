import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as KernelRefusal from "./KernelRefusal.js";

/**
 * Where a draw happens: a function of one type running, or a module loading.
 */
export type Phase = "query" | "mutation" | "action" | "load";

/**
 * What a draw reads: the phase it happens in, and the stream that phase draws
 * from. With no stream, it draws the host's.
 */
export interface Source {
  readonly phase: Phase;
  readonly random: (() => number) | undefined;
}

/**
 * The source the calling code draws from right now, or none outside the
 * kernel's code.
 */
export type Resolve = () => Source | undefined;

const integerArrays = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  BigInt64Array,
  BigUint64Array,
];

const maxRandomBytes = 65_536;

type Fillable = Parameters<Crypto["getRandomValues"]>[0];

/**
 * The binary's `getRandomValues`, filled from `random`. It checks its arguments
 * as `udf-runtime/src/00_crypto.ts:28-53` does and the byte limit as
 * `crates/isolate/src/ops/crypto.rs:15-31` does (convex-backend `cccbade4`),
 * with the same errors. It never reads its receiver, so a detached call draws
 * as an attached one.
 */
export const fill = <T extends Fillable>(
  random: () => number,
  args: ReadonlyArray<T>,
): T => {
  const prefix = "Failed to execute 'getRandomValues' on 'Crypto'";
  if (args.length < 1) {
    throw new TypeError(
      `${prefix}: 1 argument required, but only ${args.length} present.`,
    );
  }
  const array = args[0]!;
  if (
    array === null ||
    !Arr.some(integerArrays, (integers) => array instanceof integers)
  ) {
    throw new DOMException(
      "The provided ArrayBufferView is not an integer array type",
      "TypeMismatchError",
    );
  }
  if (array.byteLength > maxRandomBytes) {
    throw new TypeError(
      `Byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (${maxRandomBytes})`,
    );
  }
  const bytes = new Uint8Array(
    array.buffer,
    array.byteOffset,
    array.byteLength,
  );
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Math.floor(random() * 256);
  }
  return array;
};

/**
 * The binary's `randomUUID`: a version 4 UUID built from 16 bytes of the same
 * generator (`op_crypto_random_uuid`, `crates/isolate/src/ops/crypto.rs:8-12`,
 * through `uuid::Builder::from_random_bytes`, which sets the version and the
 * RFC 4122 variant).
 */
export const uuid = (
  random: () => number,
): ReturnType<Crypto["randomUUID"]> => {
  const bytes = fill(random, [new Uint8Array(16)]);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Arr.join(
    Arr.map(Array.from(bytes), (byte) =>
      Str.padStart(2, "0")(byte.toString(16)),
    ),
    "",
  );
  const part = (start: number, end: number) => Str.slice(start, end)(hex);
  return `${part(0, 8)}-${part(8, 12)}-${part(12, 16)}-${part(16, 20)}-${part(20, 32)}`;
};

/**
 * The binary's refusal of cryptographic randomness in a query or a mutation, at
 * run time and while a module loads for one (`not_allowed_in_udf`,
 * `crates/isolate/src/environment/udf/mod.rs:264-272` and `:290-292`). A
 * function sees it as a plain `Error` with this message, so the kernel throws
 * the same, not a tagged error.
 */
export const noCryptoRngInQueriesOrMutations =
  "Can't use cryptographic randomness in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.";

/**
 * The `crypto.subtle` operations that draw cryptographic randomness, each with
 * the algorithms it draws for. The binary asks for its `CryptoRng` in
 * `generateKey` always, in `encrypt` for RSA-OAEP and in `sign` for ECDSA and
 * RSA-PSS (`crates/isolate/src/ops/subtle_crypto/mod.rs:332`, `:401`, `:472`;
 * `crates/webcrypto/src/lib.rs:349-373`, `:478-481`, `:525-531`;
 * `crates/webcrypto/src/rsa.rs:471-475`). The rest, digest and verification
 * included, are deterministic given their inputs.
 */
const drawing = {
  generateKey: () => true,
  encrypt: (algorithm: string) => algorithm === "RSA-OAEP",
  sign: (algorithm: string) => algorithm === "ECDSA" || algorithm === "RSA-PSS",
} as const;

type DrawingOperation = keyof typeof drawing;

const operations: Record<
  DrawingOperation,
  KernelRefusal.RequiresBinary["operation"]
> = {
  generateKey: "subtleGenerateKey",
  encrypt: "subtleEncrypt",
  sign: "subtleSign",
};

const isDrawing = (property: PropertyKey): property is DrawingOperation =>
  property === "generateKey" || property === "encrypt" || property === "sign";

/**
 * An algorithm's name as WebCrypto normalises it, case-insensitively.
 */
const algorithmName = (algorithm: unknown): string =>
  Str.toUpperCase(
    typeof algorithm === "string"
      ? algorithm
      : typeof algorithm === "object" &&
          algorithm !== null &&
          "name" in algorithm &&
          typeof algorithm.name === "string"
        ? algorithm.name
        : "",
  );

/**
 * What a drawing `subtle` operation rejects with in `phase`: the binary's own
 * error in a query, a mutation or a module load, and in an action, where the
 * binary draws from the system and the kernel cannot seed it,
 * `RequiresBinary`.
 */
export const subtleRefusal = (
  phase: Phase,
  operation: DrawingOperation,
): Error | KernelRefusal.RequiresBinary =>
  phase === "action"
    ? KernelRefusal.RequiresBinary.make({
        operation: operations[operation],
        message: `crypto.subtle.${operation} draws cryptographic randomness, which the Convex binary gives an action from the system and the test kernel cannot seed. Run this case against the Convex binary.`,
      })
    : // The binary's error is a plain `Error`, not a modeled kernel failure.
      new Error(noCryptoRngInQueriesOrMutations);

const kernelSubtle = (base: SubtleCrypto, resolve: Resolve): SubtleCrypto =>
  new Proxy(base, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!isDrawing(property)) return value.bind(target);
      return (...args: Array<unknown>) => {
        const source = resolve();
        if (source !== undefined && drawing[property](algorithmName(args[0]))) {
          return Promise.reject(subtleRefusal(source.phase, property));
        }
        return Reflect.apply(value, target, args);
      };
    },
  });

/**
 * Every wrapper this module built, so the bridge can tell the kernel's globals
 * from a test's.
 */
const built = new WeakSet<object>();

/**
 * `Math` over `base`, whose `random` resolves its source on every call: the
 * source's stream, or `base`'s own `random` when it has none or there is no
 * source. A reference to `random` taken anywhere keeps resolving, so a module
 * that keeps it while it loads draws from the function that later calls it.
 */
export const kernelMath = (base: Math, resolve: Resolve): Math => {
  const random = () => {
    const stream = resolve()?.random;
    return stream === undefined
      ? Reflect.apply(Reflect.get(base, "random"), base, [])
      : stream();
  };
  const math = new Proxy(base, {
    get: (target, property, receiver) =>
      property === "random" ? random : Reflect.get(target, property, receiver),
  });
  built.add(math);
  return math;
};

/**
 * `crypto` over `base`, whose `getRandomValues` and `randomUUID` resolve their
 * source on every call. Inside a source they answer as the binary's, from its
 * stream or else from `hostRandom`. Outside one they are `base`'s own. Its
 * `subtle` refuses the operations that draw cryptographic randomness inside a
 * source, by phase.
 */
export const kernelCrypto = (
  base: Crypto,
  resolve: Resolve,
  hostRandom: () => number,
): Crypto => {
  const getRandomValues = <T extends Fillable>(...args: Array<T>): T => {
    const source = resolve();
    return source === undefined
      ? (Reflect.apply(Reflect.get(base, "getRandomValues"), base, args) as T)
      : fill(source.random ?? hostRandom, args);
  };
  const randomUUID = (): ReturnType<Crypto["randomUUID"]> => {
    const source = resolve();
    return source === undefined
      ? // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- Outside any kernel source this is the host's own randomUUID, which the kernel passes through unchanged.
        base.randomUUID()
      : uuid(source.random ?? hostRandom);
  };
  const subtle = kernelSubtle(base.subtle, resolve);
  const wrapped = new Proxy(base, {
    get: (target, property) => {
      if (property === "getRandomValues") return getRandomValues;
      if (property === "randomUUID") return randomUUID;
      if (property === "subtle") return subtle;
      // Crypto's methods and getters need the host object as `this`.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  built.add(wrapped);
  return wrapped;
};

/**
 * Whether `value` is a `Math` or `crypto` this module built.
 */
export const isBuilt = (value: unknown): boolean =>
  typeof value === "object" && value !== null && built.has(value);
