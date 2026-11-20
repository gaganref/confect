import { componentsGeneric } from "convex/server";

export type Components = {
  "guarded": import("../../components/guarded/convex/_generated/component.js").ComponentApi<"guarded">;
};

export const components: Components = componentsGeneric() as any;
