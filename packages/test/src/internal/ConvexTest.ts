import type {
  GenericSchema,
  SchemaDefinition,
  UserIdentity,
} from "convex/server";
import { componentsGeneric } from "convex/server";
import * as Execution from "./Execution.js";
import type * as Kernel from "./Kernel.js";
import * as KernelRefusal from "./KernelRefusal.js";
import * as Subscriptions from "./Subscriptions.js";
import type * as Scheduling from "./Scheduling.js";

type Modules = Record<string, () => Promise<any>>;

/**
 * What the kernel adds to convex-test's surface, typed. The shim itself returns
 * `any`, as convex-test's callers expect.
 */
export interface KernelControls {
  readonly query: (reference: any, args?: any) => Promise<any>;
  readonly mutation: (reference: any, args?: any) => Promise<any>;
  readonly action: (reference: any, args?: any) => Promise<any>;
  readonly prepare: (
    reference: any,
    args?: any,
  ) => Promise<Execution.HeldAttempt>;
  readonly apply: (id: string) => Promise<Execution.KernelApply>;
  readonly held: () => ReadonlyArray<Execution.HeldAttempt>;
  readonly withIdentity: (identity: Partial<UserIdentity>) => KernelControls;
  readonly withRequestMetadata: (metadata: {
    readonly ip?: string | null;
    readonly userAgent?: string | null;
  }) => KernelControls;
  /**
   * A client's query set under this accessor's caller.
   */
  readonly subscriber: () => Subscriptions.Subscriber;
  /**
   * Rerun every stale subscription. Lists each one whose value changed.
   */
  readonly refresh: () => Promise<ReadonlyArray<Subscriptions.Transition>>;
  /**
   * Rerun every subscription from scratch. Lists each one whose value differs
   * from the full rerun.
   */
  readonly reference: () => Promise<ReadonlyArray<Subscriptions.Disagreement>>;
  /**
   * The provider port calls actions made, held until answered, oldest first.
   */
  readonly commands: () => ReadonlyArray<Execution.HeldCommand>;
  /**
   * Answer a held command, so its port call returns `output`.
   */
  readonly answer: (id: string, output: unknown) => void;
  /**
   * Move the kernel's clock forward, running each job due on the way at its
   * deadline.
   */
  readonly advance: (ms: number) => Promise<void>;
  /**
   * The pending jobs, earliest deadline first.
   */
  readonly jobs: () => ReadonlyArray<Scheduling.Job>;
  /**
   * Run the jobs due now. No future deadline is crossed.
   */
  readonly finishInProgressScheduledFunctions: () => Promise<void>;
  /**
   * Run jobs at their deadlines until only standing jobs remain, or fail with
   * `DrainBudgetExceeded` after `maxIterations` jobs. The kernel keeps its own
   * clock, so it never calls `advanceTimers`.
   */
  readonly finishAllScheduledFunctions: (
    advanceTimers?: () => void,
    maxIterations?: number,
  ) => Promise<void>;
}

/**
 * How a kit registers a component beyond its schema and modules.
 */
export interface RegisterOptions {
  /**
   * The component's functions, as `module:export`, that schedule their own next
   * run, such as the crons component's `public:rescheduler`. A job that runs
   * one, or that one schedules, is never drain work.
   */
  readonly standing?: ReadonlyArray<string>;
}

const isSchemaDefinition = (
  value: unknown,
): value is SchemaDefinition<GenericSchema, boolean> =>
  value !== null &&
  typeof value === "object" &&
  "tables" in value &&
  typeof (value as { tables: unknown }).tables === "object";

const accessor = (
  world: Execution.World,
  subscriptions: Subscriptions.Registry,
  caller: Execution.Caller,
): any => ({
  query: (reference: any, args?: any) => world.query(caller, reference, args),
  mutation: (reference: any, args?: any) =>
    world.mutation(caller, reference, args),
  action: (reference: any, args?: any) => world.action(caller, reference, args),
  prepare: (reference: any, args?: any) =>
    world.prepare(caller, reference, args),
  apply: (id: string) => world.apply(id),
  held: () => world.held(),
  commands: () => world.commands(),
  answer: (id: string, output: unknown) => world.answer(id, output),
  subscriber: () => subscriptions.subscriber(caller),
  refresh: () => subscriptions.refresh(),
  reference: () => subscriptions.reference(),
  run: (handler: (ctx: any) => any) => world.run(caller, "", handler),
  runInComponent: (componentPath: string, handler: (ctx: any) => any) =>
    world.run(caller, componentPath, handler),
  withIdentity: (identity: Partial<UserIdentity>) =>
    accessor(world, subscriptions, Execution.withIdentity(caller, identity)),
  withRequestMetadata: (metadata: {
    readonly ip?: string | null;
    readonly userAgent?: string | null;
  }) =>
    accessor(world, subscriptions, {
      ...caller,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
    }),
  fetch: () => Promise.reject(KernelRefusal.rowPending("HTTP routes", 6)),
  jwks: () => Promise.reject(KernelRefusal.rowPending("JWT verification", 6)),
  advance: (ms: number) => world.advance(ms),
  jobs: () => world.jobs(),
  finishInProgressScheduledFunctions: () => world.advance(0),
  finishAllScheduledFunctions: (
    _advanceTimers?: () => void,
    maxIterations?: number,
  ) => world.drain(maxIterations),
});

/**
 * The test kernel under convex-test's `convexTest` signature. The fork's kernel
 * lane aliases `convex-test` to this module, so every suite that calls
 * `convexTest` directly, and `TestConfect` itself, runs on the kernel.
 *
 * Beyond convex-test, `prepare` runs a mutation to its commit point and holds
 * it, and `apply` validates and publishes a held attempt. `mutation` applies
 * each attempt it prepares at once and prepares the next on a conflict, up to
 * attempt 5. `runtime` supplies the clock and commit timestamps. Scheduled
 * functions run on the kernel's clock, never on a host timer. A subscriber's
 * subscriptions go stale when a commit changes what they read or the identity
 * they read changes, and `refresh` reruns them. An action's raw `fetch` dies
 * with `BackendRefusal` `UndeclaredFetch`, and its provider port calls wait in
 * `commands` until `answer` settles them.
 */
export function convexTest(
  schemaOrOptions?:
    | SchemaDefinition<GenericSchema, boolean>
    | {
        readonly schema?: SchemaDefinition<GenericSchema, boolean>;
        readonly modules?: Modules;
        readonly transactionLimits?: unknown;
        readonly runtime?: Kernel.KernelRuntime;
      },
  modules?: Modules,
): any {
  let schema: SchemaDefinition<GenericSchema, boolean> | undefined;
  let runtime: Kernel.KernelRuntime | undefined;
  if (isSchemaDefinition(schemaOrOptions)) {
    schema = schemaOrOptions;
  } else if (schemaOrOptions !== undefined) {
    if (schemaOrOptions.transactionLimits !== undefined) {
      throw KernelRefusal.rowPending("transaction limits", 6);
    }
    schema = schemaOrOptions.schema;
    modules = schemaOrOptions.modules;
    runtime = schemaOrOptions.runtime;
  }
  if (modules === undefined) {
    throw new Error(
      "The test kernel needs the modules map: pass `import.meta.glob(...)` as the second argument.",
    );
  }
  const world = new Execution.World(schema, modules, runtime);
  return {
    ...accessor(world, new Subscriptions.Registry(world), Execution.anonymous),
    registerComponent: (
      componentPath: string,
      componentSchema: SchemaDefinition<GenericSchema, boolean>,
      componentModules: Modules,
      options?: RegisterOptions,
    ) => {
      world.register(
        componentPath,
        componentSchema,
        componentModules,
        options?.standing,
      );
      return (componentsGeneric() as any)[componentPath];
    },
  };
}
