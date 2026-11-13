import type {
  GenericSchema,
  SchemaDefinition,
  UserIdentity,
} from "convex/server";
import { componentsGeneric } from "convex/server";
import * as Execution from "./Execution.js";
import type * as Invocation from "./Invocation.js";
import type * as Redaction from "./Redaction.js";
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
  /**
   * The committed state as snapshot bytes, bound to their SHA-256 digest. Two
   * exports of the same state are the same bytes.
   */
  readonly exportSnapshot: () => Uint8Array;
  /**
   * Replace a fresh backend's state with a snapshot's. Each job's world
   * resolves by name among `worlds`. Tampered bytes refuse with
   * `SnapshotDigestMismatch`.
   */
  readonly restoreSnapshot: (
    bytes: Uint8Array,
    options?: {
      readonly worlds?: ReadonlyArray<Invocation.World>;
      readonly secrets?: Redaction.Secrets;
    },
  ) => Promise<void>;
  /**
   * A copy of the raw secrets the backend has seen under a secret schema node.
   * A snapshot marks each one, and a restore given this copy puts them back. It
   * lives in memory and is never written to an artifact.
   */
  readonly secrets: () => Redaction.Secrets;
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
): any => {
  // Every failure the kernel hands back is a report a test runner prints, so
  // each leaves through the world's redaction.
  const reported = <A>(run: () => Promise<A>): Promise<A> =>
    run().catch((error: unknown) => {
      throw world.redactFailure(error);
    });
  // A diff names its subscription; its outcomes are marked by the shape of
  // what that subscription's query returns.
  const returnsOf = (subscription: string) =>
    world.functionPathOf(subscriptions.referenceOf(subscription));
  return {
    query: (reference: any, args?: any) =>
      reported(() => world.query(caller, reference, args)),
    mutation: (reference: any, args?: any) =>
      reported(() => world.mutation(caller, reference, args)),
    action: (reference: any, args?: any) =>
      reported(() => world.action(caller, reference, args)),
    prepare: (reference: any, args?: any) =>
      reported(() => world.prepare(caller, reference, args)).then((view) =>
        world.projectHeld(view),
      ),
    apply: (id: string) => {
      // The attempt leaves `held` once applied, so its function is read first.
      const functionPath = world
        .held()
        .find((view) => view.id === id)?.functionPath;
      return reported(() => world.apply(id)).then((applied) =>
        world.projectApplied(applied, functionPath),
      );
    },
    held: () => world.held().map((view) => world.projectHeld(view)),
    subscriber: () => subscriptions.subscriber(caller),
    refresh: () =>
      reported(() => subscriptions.refresh()).then((transitions) =>
        transitions.map((transition): Subscriptions.Transition => ({
          ...transition,
          from: world.redactOutcome(
            transition.from,
            returnsOf(transition.subscription),
          ),
          to: world.redactOutcome(
            transition.to,
            returnsOf(transition.subscription),
          ),
          because:
            transition.because.kind === "commit"
              ? {
                  kind: "commit",
                  change: world.redactChange(transition.because.change),
                }
              : transition.because,
        })),
      ),
    reference: () =>
      reported(() => subscriptions.reference()).then((disagreements) =>
        disagreements.map((disagreement): Subscriptions.Disagreement => ({
          ...disagreement,
          incremental: world.redactOutcome(
            disagreement.incremental,
            returnsOf(disagreement.subscription),
          ),
          reference: world.redactOutcome(
            disagreement.reference,
            returnsOf(disagreement.subscription),
          ),
        })),
      ),
    run: (handler: (ctx: any) => any) =>
      reported(() => world.run(caller, "", handler)),
    runInComponent: (componentPath: string, handler: (ctx: any) => any) =>
      reported(() => world.run(caller, componentPath, handler)),
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
    advance: (ms: number) => reported(() => world.advance(ms)),
    jobs: () => world.jobs(),
    finishInProgressScheduledFunctions: () => reported(() => world.advance(0)),
    finishAllScheduledFunctions: (
      _advanceTimers?: () => void,
      maxIterations?: number,
    ) => reported(() => world.drain(maxIterations)),
    exportSnapshot: () => world.exportSnapshot(),
    restoreSnapshot: (
      bytes: Uint8Array,
      options?: {
        readonly worlds?: ReadonlyArray<Invocation.World>;
        readonly secrets?: Redaction.Secrets;
      },
    ) => world.restoreSnapshot(bytes, options),
    secrets: () => world.keptSecrets(),
  };
};

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
 * they read changes, and `refresh` reruns them. `redaction` names the secret
 * schema nodes of tables and functions: a value under one reaches a snapshot, a
 * failure report or a diff only as a marker.
 */
export function convexTest(
  schemaOrOptions?:
    | SchemaDefinition<GenericSchema, boolean>
    | {
        readonly schema?: SchemaDefinition<GenericSchema, boolean>;
        readonly modules?: Modules;
        readonly transactionLimits?: unknown;
        readonly runtime?: Kernel.KernelRuntime;
        readonly redaction?: Redaction.Policy;
      },
  modules?: Modules,
): any {
  let schema: SchemaDefinition<GenericSchema, boolean> | undefined;
  let runtime: Kernel.KernelRuntime | undefined;
  let redaction: Redaction.Policy | undefined;
  if (isSchemaDefinition(schemaOrOptions)) {
    schema = schemaOrOptions;
  } else if (schemaOrOptions !== undefined) {
    if (schemaOrOptions.transactionLimits !== undefined) {
      throw KernelRefusal.rowPending("transaction limits", 6);
    }
    schema = schemaOrOptions.schema;
    modules = schemaOrOptions.modules;
    runtime = schemaOrOptions.runtime;
    redaction = schemaOrOptions.redaction;
  }
  if (modules === undefined) {
    throw new Error(
      "The test kernel needs the modules map: pass `import.meta.glob(...)` as the second argument.",
    );
  }
  const world = new Execution.World(schema, modules, runtime, redaction);
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
