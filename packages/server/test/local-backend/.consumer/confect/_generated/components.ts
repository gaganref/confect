import { componentsGeneric } from "convex/server";

export type Components = {
  "counter": import("../../components/counter/convex/_generated/component.js").ComponentApi<"counter">;
  "kitted": import("counter-kit/_generated/component.js").ComponentApi<"kitted">;
};

export const components: Components = componentsGeneric() as any;
