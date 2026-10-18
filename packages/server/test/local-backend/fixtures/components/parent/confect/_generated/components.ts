import { componentsGeneric } from "convex/server";

export type Components = {
  "child": import("../../../counter/convex/_generated/component.js").ComponentApi<"child">;
  "deep": import("../../../middle/convex/_generated/component.js").ComponentApi<"deep">;
};

export const components: Components = componentsGeneric() as any;
