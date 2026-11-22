import { componentsGeneric } from "convex/server";

export type Components = {
  "child": import("../../../counter/confect/_generated/component.js").ComponentApi<"child">;
  "deep": import("../../../middle/confect/_generated/component.js").ComponentApi<"deep">;
};

export const components: Components = componentsGeneric() as any;
