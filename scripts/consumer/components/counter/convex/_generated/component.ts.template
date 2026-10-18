import type { FunctionReference } from "convex/server";
// The wire API normally emitted by Convex codegen, which needs a deployment.
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  counter: {
    increment: FunctionReference<"query", "internal", { value: number }, number, Name>;
    notify: FunctionReference<"mutation", "internal", { value: number; onResult: string }, number, Name>;
  };
};
