import type {
  GenericSchema,
  SchemaDefinition,
  UserIdentity,
} from "convex/server";
import { componentsGeneric } from "convex/server";
import * as Execution from "./Execution.js";
import * as KernelRefusal from "./KernelRefusal.js";

type Modules = Record<string, () => Promise<any>>;

const isSchemaDefinition = (
  value: unknown,
): value is SchemaDefinition<GenericSchema, boolean> =>
  value !== null &&
  typeof value === "object" &&
  "tables" in value &&
  typeof (value as { tables: unknown }).tables === "object";

const accessor = (world: Execution.World, caller: Execution.Caller): any => ({
  query: (reference: any, args?: any) => world.query(caller, reference, args),
  mutation: (reference: any, args?: any) =>
    world.mutation(caller, reference, args),
  action: (reference: any, args?: any) => world.action(caller, reference, args),
  run: (handler: (ctx: any) => any) => world.run(caller, "", handler),
  runInComponent: (componentPath: string, handler: (ctx: any) => any) =>
    world.run(caller, componentPath, handler),
  withIdentity: (identity: Partial<UserIdentity>) =>
    accessor(world, Execution.withIdentity(caller, identity)),
  withRequestMetadata: (metadata: {
    readonly ip?: string | null;
    readonly userAgent?: string | null;
  }) =>
    accessor(world, {
      ...caller,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
    }),
  fetch: () => Promise.reject(KernelRefusal.rowPending("HTTP routes", 6)),
  jwks: () => Promise.reject(KernelRefusal.rowPending("JWT verification", 6)),
  finishInProgressScheduledFunctions: () =>
    Promise.reject(KernelRefusal.rowPending("the scheduler", 5)),
  finishAllScheduledFunctions: () =>
    Promise.reject(KernelRefusal.rowPending("the scheduler", 5)),
});

/**
 * The test kernel under convex-test's `convexTest` signature. The fork's kernel
 * lane aliases `convex-test` to this module, so every suite that calls
 * `convexTest` directly, and `TestConfect` itself, runs on the kernel.
 */
export function convexTest(
  schemaOrOptions?:
    | SchemaDefinition<GenericSchema, boolean>
    | {
        readonly schema?: SchemaDefinition<GenericSchema, boolean>;
        readonly modules?: Modules;
        readonly transactionLimits?: unknown;
      },
  modules?: Modules,
): any {
  let schema: SchemaDefinition<GenericSchema, boolean> | undefined;
  if (isSchemaDefinition(schemaOrOptions)) {
    schema = schemaOrOptions;
  } else if (schemaOrOptions !== undefined) {
    if (schemaOrOptions.transactionLimits !== undefined) {
      throw KernelRefusal.rowPending("transaction limits", 6);
    }
    schema = schemaOrOptions.schema;
    modules = schemaOrOptions.modules;
  }
  if (modules === undefined) {
    throw new Error(
      "The test kernel needs the modules map: pass `import.meta.glob(...)` as the second argument.",
    );
  }
  const world = new Execution.World(schema, modules);
  return {
    ...accessor(world, Execution.anonymous),
    registerComponent: (
      componentPath: string,
      componentSchema: SchemaDefinition<GenericSchema, boolean>,
      componentModules: Modules,
    ) => {
      world.register(componentPath, componentSchema, componentModules);
      return (componentsGeneric() as any)[componentPath];
    },
  };
}
