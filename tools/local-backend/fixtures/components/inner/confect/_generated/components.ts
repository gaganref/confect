import { componentsGeneric } from "convex/server";

export type Components = {
  "child": import("../../../counter/confect/_generated/component.js").ComponentApi<"child">;
};

export const components: Components = componentsGeneric() as any;
