import { componentsGeneric } from "convex/server";

export type Components = {
  "child": import("../../../inner/convex/_generated/component.js").ComponentApi<"child">;
};

export const components: Components = componentsGeneric() as any;
