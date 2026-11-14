import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "../_generated/schema";
import spec from "./randomness.spec";

type Use = {
  readonly permitted: boolean;
  readonly name: string | null;
  readonly message: string | null;
  readonly value: ReadonlyArray<number>;
};

const refused = (error: unknown): Use => {
  const { name, message } = error as Error;
  return { permitted: false, name, message, value: [] };
};

/**
 * Run `draw` and record whether the backend permitted it.
 */
const use = (draw: () => ReadonlyArray<number>): Use => {
  try {
    return { permitted: true, name: null, message: null, value: [...draw()] };
  } catch (error) {
    return refused(error);
  }
};

/**
 * Run the asynchronous `draw` and record whether the backend permitted it.
 */
const useAsync = (draw: () => Promise<ReadonlyArray<number>>): Promise<Use> =>
  Promise.resolve()
    .then(draw)
    .then(
      (value): Use => ({
        permitted: true,
        name: null,
        message: null,
        value: [...value],
      }),
      refused,
    );

/**
 * A fill's length and how many distinct bytes it holds. A real fill of 65,536
 * bytes holds nearly all 256; a zero fill holds one.
 */
const spread = (bytes: Uint8Array) => [bytes.length, new Set(bytes).size];

const v4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A UUID's length and whether it has the version 4 layout.
 */
const uuidShape = (uuid: string) => [uuid.length, v4.test(uuid) ? 1 : 0];

const hmac = { name: "HMAC", hash: "SHA-256" } as const;

const generateKey = () =>
  crypto.subtle.generateKey(hmac, true, ["sign"]).then(() => [1]);

const digest = () =>
  crypto.subtle
    .digest("SHA-256", new Uint8Array([1, 2, 3]))
    .then((bytes) => [...new Uint8Array(bytes)]);

const atLoad = {
  // oxlint-disable-next-line effecttsgo/global-random -- The probe reads the ambient Math.random the backend gives a module and a function.
  loadMathRandom: use(() => [Math.random()]),
  loadGetRandomValues: use(() => [
    ...crypto.getRandomValues(new Uint8Array(4)),
  ]),
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The probe reads the ambient crypto.randomUUID the backend gives a module.
  loadRandomUUID: use(() => uuidShape(crypto.randomUUID())),
};

const loadGenerateKey = useAsync(generateKey);

const sample = Effect.gen(function* () {
  const drawn = {
    // oxlint-disable-next-line effecttsgo/global-random -- The probe reads the ambient Math.random the backend gives a module and a function.
    mathRandom: use(() => [Math.random()]),
    getRandomValues: use(() => [...crypto.getRandomValues(new Uint8Array(4))]),
    largestFill: use(() =>
      spread(crypto.getRandomValues(new Uint8Array(65536))),
    ),
    oversizedFill: use(() => [
      crypto.getRandomValues(new Uint8Array(65537)).length,
    ]),
    floatFill: use(() => [crypto.getRandomValues(new Float64Array(1)).length]),
    detachedFill: use(() => {
      // oxlint-disable-next-line typescript/unbound-method -- The probe calls it detached on purpose.
      const { getRandomValues } = crypto;
      return [...getRandomValues(new Uint8Array(4))];
    }),
    // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The probe reads the ambient crypto.randomUUID the backend gives a function.
    randomUUID: use(() => uuidShape(crypto.randomUUID())),
  };
  const generated = yield* Effect.promise(() => useAsync(generateKey));
  const digested = yield* Effect.promise(() => useAsync(digest));
  const loadGenerated = yield* Effect.promise(() => loadGenerateKey);
  return {
    ...drawn,
    generateKey: generated,
    digest: digested,
    ...atLoad,
    loadGenerateKey: loadGenerated,
  };
});

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([
    FunctionImpl.make(schema, spec, "query", () => sample),
    FunctionImpl.make(schema, spec, "mutation", () => sample),
    FunctionImpl.make(schema, spec, "action", () => sample),
  ]),
  GroupImpl.finalize,
);
