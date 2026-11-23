import { componentsGeneric } from "convex/server";

export type Components = {
  "guarded": import("../../components/guarded/confect/_generated/component.js").ComponentApi<"guarded">;
  "tabled": import("../../components/tabled/confect/_generated/component.js").ComponentApi<"tabled">;
};

export const components: Components = componentsGeneric() as any;
