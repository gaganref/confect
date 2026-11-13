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

// oxlint-disable effecttsgo/global-random-in-effect -- The probe reads the ambient random sources the backend gives a module and a function.
const atLoad = {
  loadMathRandom: use(() => [Math.random()]),
  loadGetRandomValues: use(() => [
    ...crypto.getRandomValues(new Uint8Array(4)),
  ]),
};

const sample = Effect.sync(() => ({
  mathRandom: use(() => [Math.random()]),
  getRandomValues: use(() => [...crypto.getRandomValues(new Uint8Array(4))]),
  largestFill: use(() => [crypto.getRandomValues(new Uint8Array(65536)).length]),
  oversizedFill: use(() => [
    crypto.getRandomValues(new Uint8Array(65537)).length,
  ]),
  floatFill: use(() => [crypto.getRandomValues(new Float64Array(1)).length]),
  detachedFill: use(() => {
    const { getRandomValues } = crypto;
    // oxlint-disable-next-line typescript/unbound-method -- The probe calls it detached on purpose.
    return [getRandomValues(new Uint8Array(4)).length];
  }),
  randomUUID: use(() => [crypto.randomUUID().length]),
  ...atLoad,
}));
// oxlint-enable effecttsgo/global-random-in-effect

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([
    FunctionImpl.make(schema, spec, "query", () => sample),
    FunctionImpl.make(schema, spec, "mutation", () => sample),
    FunctionImpl.make(schema, spec, "action", () => sample),
  ]),
  GroupImpl.finalize,
);
