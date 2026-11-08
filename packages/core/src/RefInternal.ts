import { makeFunctionReference } from "convex/server";
import type * as Ref from "./Ref.js";

const functionReferenceCache = new Map<
  string,
  Ref.FunctionReference<Ref.Any>
>();

export const getFunctionReference = <Ref_ extends Ref.Any>(
  ref: Ref_,
): Ref.FunctionReference<Ref_> => {
  if (ref.functionReference !== undefined) {
    return ref.functionReference as Ref.FunctionReference<Ref_>;
  }
  const convexFunctionName = ref.convexFunctionName;

  const cached = functionReferenceCache.get(convexFunctionName);
  if (cached !== undefined) {
    return cached as Ref.FunctionReference<Ref_>;
  }

  const functionReference = makeFunctionReference(convexFunctionName);
  functionReferenceCache.set(convexFunctionName, functionReference);

  return functionReference as Ref.FunctionReference<Ref_>;
};
