import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "../_generated/schema";
import spec from "./randomness.spec";

/**
 * Run `draw` and record whether the backend permitted it.
 */
const use = (draw: () => ReadonlyArray<number>) => {
  try {
    return { permitted: true, name: null, message: null, value: [...draw()] };
  } catch (error) {
    const { name, message } = error as Error;
    return { permitted: false, name, message, value: [] };
  }
};

const atLoad = {
  // oxlint-disable-next-line effecttsgo/global-random -- The probe reads the ambient Math.random the backend gives a module and a function.
  loadMathRandom: use(() => [Math.random()]),
  loadGetRandomValues: use(() => [
    ...crypto.getRandomValues(new Uint8Array(4)),
  ]),
};

const sample = Effect.sync(() => ({
  // oxlint-disable-next-line effecttsgo/global-random -- The probe reads the ambient Math.random the backend gives a module and a function.
  mathRandom: use(() => [Math.random()]),
  getRandomValues: use(() => [...crypto.getRandomValues(new Uint8Array(4))]),
  largestFill: use(() => [
    crypto.getRandomValues(new Uint8Array(65536)).length,
  ]),
  oversizedFill: use(() => [
    crypto.getRandomValues(new Uint8Array(65537)).length,
  ]),
  floatFill: use(() => [crypto.getRandomValues(new Float64Array(1)).length]),
  detachedFill: use(() => {
    // oxlint-disable-next-line typescript/unbound-method -- The probe calls it detached on purpose.
    const { getRandomValues } = crypto;
    return [getRandomValues(new Uint8Array(4)).length];
  }),
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The probe reads the ambient crypto.randomUUID the backend gives a function.
  randomUUID: use(() => [crypto.randomUUID().length]),
  ...atLoad,
}));

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([
    FunctionImpl.make(schema, spec, "query", () => sample),
    FunctionImpl.make(schema, spec, "mutation", () => sample),
    FunctionImpl.make(schema, spec, "action", () => sample),
  ]),
  GroupImpl.finalize,
);
