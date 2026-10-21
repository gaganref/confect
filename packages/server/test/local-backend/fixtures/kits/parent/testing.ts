import type { SchemaDefinition } from "convex/server";
import counterSchema from "../../components/counter/convex/schema.js";
import parentSchema from "../../components/parent/convex/schema.js";

type Modules = Record<string, () => Promise<unknown>>;

// convex-test finds a component's root by its `_generated` key.
const root = { "_generated/testing.ts": () => Promise.resolve({}) };

const parentModules: Modules = {
  ...root,
  "parent.ts": () => import("../../components/parent/convex/parent.js"),
  "schema.ts": () => import("../../components/parent/convex/schema.js"),
};

const counterModules: Modules = {
  ...root,
  "authoring.ts": () => import("../../components/counter/convex/authoring.js"),
  "counter.ts": () => import("../../components/counter/convex/counter.js"),
  "crons.ts": () => import("../../components/counter/convex/crons.js"),
  "deliveries.ts": () =>
    import("../../components/counter/convex/deliveries.js"),
  "http.ts": () => import("../../components/counter/convex/http.js"),
  "schema.ts": () => import("../../components/counter/convex/schema.js"),
};

/**
 * A wrapper package's kit in the aggregate shape: it registers the component
 * and the nested child the component calls, which the generated registry leaves
 * to the kit.
 */
export function register(
  t: {
    readonly registerComponent: (
      name: string,
      schema: SchemaDefinition<any, boolean>,
      modules: Modules,
    ) => void;
  },
  name: string,
): void {
  t.registerComponent(name, parentSchema, parentModules);
  t.registerComponent(`${name}/child`, counterSchema, counterModules);
}
