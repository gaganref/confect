import { AsyncLocalStorage } from "node:async_hooks";
import {
  actionGeneric,
  getFunctionAddress,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericSchema,
  type SchemaDefinition,
  type UserIdentity,
} from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { KernelAttempt } from "./Attempt.js";
import * as Clock from "./Clock.js";
import * as Globals from "./Globals.js";
import * as Invocation from "./Invocation.js";
import * as Kernel from "./Kernel.js";
import * as KernelQuery from "./KernelQuery.js";
import * as KernelRefusal from "./KernelRefusal.js";
import type * as ReadSet from "./ReadSet.js";
import * as Scheduling from "./Scheduling.js";
import type {
  DocumentId,
  FunctionPath,
  StoredDocument,
  ValidatorJSON,
} from "./KernelValues.js";
import {
  createFunctionHandle,
  createTestJwt,
  deserializeConvexErrorData,
  evaluateValue,
  hasPendingValues,
  parseArgs,
  parseFunctionHandle,
  resolveCommittedValues,
  simpleHash,
  tableNameFromId,
  validateFunctionArgs,
  validateReturnValue,
} from "./KernelValues.js";

const ROOT = "";
const TYPICAL_CONVEX_ID_LENGTH = 32;

type Modules = Record<string, () => Promise<any>>;

/**
 * One registered component: its schema, its function modules, each loaded once
 * when the world opens, and its standing sources.
 */
interface Component {
  readonly path: string;
  readonly schema: KernelQuery.KernelSchema | null;
  readonly loaders: ReadonlyMap<string, () => Promise<any>>;
  readonly loaded: Map<string, any>;
  /**
   * The functions, as `module:export`, that schedule their own next run. A job
   * that runs one, or that one schedules, is never drain work.
   */
  readonly standing: ReadonlySet<string>;
}

/**
 * Who is calling: the identity and the request attributes a test accessor set.
 */
export interface Caller {
  readonly identity: UserIdentity | null;
  readonly token: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export const anonymous: Caller = {
  identity: null,
  token: null,
  ip: null,
  userAgent: null,
};

export const withIdentity = (
  caller: Caller,
  identity: Partial<UserIdentity>,
): Caller => {
  const subject = identity.subject ?? "" + simpleHash(JSON.stringify(identity));
  const issuer = identity.issuer ?? "https://convex.test";
  const tokenIdentifier = identity.tokenIdentifier ?? `${issuer}|${subject}`;
  const full = { ...identity, subject, issuer, tokenIdentifier };
  return { ...caller, identity: full, token: createTestJwt(full) };
};

interface Request {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  readonly scheduledFunctionId: string | null;
  readonly authToken: string | null;
}

type UdfType = "query" | "mutation" | "action";

/**
 * How a prepared attempt's function ended.
 */
export type Outcome =
  | { readonly _tag: "returned"; readonly value: Value }
  | { readonly _tag: "failed"; readonly error: unknown };

/**
 * A mutation attempt run to its commit point and held until `apply`.
 */
export interface HeldAttempt {
  readonly id: string;
  readonly request: string;
  readonly number: Invocation.Attempt;
  readonly snapshot: Kernel.Version;
  readonly reads: ReadonlyArray<ReadSet.Read>;
  readonly outcome: Outcome;
}

/**
 * What `apply` did with a held attempt. A conflict discards the attempt and
 * holds exactly one next attempt, run against the latest commit. Nothing is
 * retried until that one is applied in turn.
 */
export type KernelApply =
  | {
      readonly kind: "applied";
      readonly version: Kernel.Version;
      readonly commitTs: bigint;
      readonly result: Value;
    }
  | { readonly kind: "conflict"; readonly next: HeldAttempt }
  | {
      readonly kind: "exhausted";
      readonly error: KernelRefusal.OptimisticConcurrencyControlFailure;
    }
  | { readonly kind: "refused"; readonly tag: string; readonly error: unknown };

/**
 * One top-level query run and every dependency it took: the commit and reads it
 * read, whether it asked for the caller's identity, the pinned time it read and
 * the end of its paginated read.
 */
export interface QueryRun {
  readonly outcome: Outcome;
  readonly snapshot: Kernel.Version;
  readonly reads: ReadonlyArray<ReadSet.Read>;
  readonly observedIdentity: boolean;
  /**
   * The pinned time the query read, or `null` when it never read the time.
   */
  readonly time: number | null;
  /**
   * Where the query's paginated read ended, or `null` when it ran none. A rerun
   * ends its page there, as the binary's query journal does.
   */
  readonly journal: string | null;
}

/**
 * The one paginated read a query and its nested calls may run. `journal` is
 * where a previous run's page ended, and `end` where this run's page ends.
 */
interface Pagination {
  calls: number;
  readonly journal: string | null;
  end: string | null;
}

/**
 * A top-level query whose attempt and page the caller keeps, at a pinned start
 * time or the kernel's time now.
 */
interface TopQuery {
  readonly attempt: KernelAttempt;
  readonly pagination: Pagination;
  readonly startTime: number | undefined;
}

interface Held {
  readonly view: HeldAttempt;
  readonly attempt: KernelAttempt;
  readonly again: (number: Invocation.Attempt) => Promise<Held>;
}

const lastAttempt: Invocation.Attempt = 5;

const tagOf = (error: unknown): string => {
  const tagged = (value: unknown): value is { readonly _tag: string } =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { _tag?: unknown })._tag === "string";
  const data = (error as { data?: unknown } | null)?.data;
  if (tagged(data)) return data._tag;
  if (tagged(error)) return error._tag;
  return error instanceof Error ? error.name : "Error";
};

/**
 * One running function. Queries and mutations read and write through their
 * attempt. Every async syscall of a query or a mutation, nested calls included,
 * takes its turn on `turn` in the order the function made it.
 */
interface Execution {
  readonly world: World;
  readonly componentPath: string;
  readonly udfPath: string;
  readonly udfType: UdfType;
  readonly attempt: KernelAttempt | undefined;
  readonly identity: UserIdentity | null;
  readonly request: Request;
  /**
   * The kernel's time when the outermost query or mutation began. Its nested
   * calls share it, and `Date` answers it inside them.
   */
  readonly startTime: number;
  readonly pagination: Pagination | undefined;
  readonly turn: Turn;
}

/**
 * A queue that runs one task at a time, in the order they were taken.
 */
class Turn {
  private tail: Promise<unknown> = Promise.resolve();

  take<A>(task: () => A | Promise<A>): Promise<A> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Resolves once every task taken so far has settled, including the tasks
   * taken while waiting.
   */
  idle(): Promise<void> {
    const tail = this.tail;
    return tail.then(() => (this.tail === tail ? undefined : this.idle()));
  }
}

/**
 * A function's invocation finishes once its handler returned and every syscall
 * it started has run. On the binary a query or mutation keeps running the
 * syscalls in its queue after its promise resolves, then returns (`run_inner`
 * in `crates/isolate/src/environment/udf/mod.rs`, 1.49), so an unawaited write
 * still lands in its own transaction.
 */
const settled = <A>(execution: Execution, result: A): Promise<A> =>
  execution.turn.idle().then(() => result);

const executions = new AsyncLocalStorage<Execution>();

/**
 * Run a function's code as `execution`, with its own copy of the globals a test
 * invocation pins.
 */
const enter = <A>(execution: Execution, run: () => A): A => {
  installConvexGlobal();
  return Globals.own(() => executions.run(execution, run));
};
const kernelBrand = Symbol.for("@confect/test/Kernel");

/**
 * The time `Date` answers inside a kernel invocation: a query's or mutation's
 * start, or the clock as it runs in an action. Outside one, none. A query or
 * mutation that reads it takes a dependency on that time.
 */
const pinnedTime = (): number | undefined => {
  const execution = executions.getStore();
  if (execution === undefined) return undefined;
  if (execution.udfType === "action") return execution.world.now();
  execution.attempt?.observeTime(execution.startTime);
  return execution.startTime;
};

/**
 * How many jobs one drain or advance runs before it gives up, as convex-test's
 * `finishAllScheduledFunctions` defaults to.
 */
const defaultBudget = 100;

const current = (): Execution => {
  const execution = executions.getStore();
  if (execution === undefined) {
    throw new Error(
      "A Convex syscall ran outside any function the test kernel started.",
    );
  }
  return execution;
};

let nextRequestId = 0;
const newRequest = (caller: Caller): Request => ({
  ip: caller.ip,
  userAgent: caller.userAgent,
  requestId: `kernel-request-${nextRequestId++}`,
  scheduledFunctionId: null,
  authToken: caller.token,
});

/**
 * A scheduled call is a request of its own: no caller's attributes, and its
 * job's ID.
 */
const jobRequest = (jobId: DocumentId): Request => ({
  ...newRequest(anonymous),
  scheduledFunctionId: jobId,
});

const findModulesRoot = (paths: ReadonlyArray<string>): string => {
  const generated = paths.find((path) => path.includes("_generated"));
  if (generated === undefined) {
    throw new Error(
      'Could not find the "_generated" directory, make sure to run ' +
        "`npx convex dev` or `npx convex codegen`. Make sure your " +
        '`import.meta.glob` includes the files in the "_generated" directory',
    );
  }
  return generated.split("_generated", 2)[0]!;
};

const makeComponent = (
  path: string,
  schema: SchemaDefinition<GenericSchema, boolean> | null | undefined,
  modules: Modules,
  standing: ReadonlyArray<string> = [],
): Component => {
  const root = findModulesRoot(Object.keys(modules));
  const relative = Object.entries(modules)
    .filter(([key]) => key.startsWith(root))
    .map(([key, load]) => [key.slice(root.length), load] as const);
  const nested = relative
    .map(([file]) => file)
    .filter((file) => file.endsWith("/convex.config.ts"))
    .map((file) => file.slice(0, -"convex.config.ts".length));
  return {
    path,
    schema: KernelQuery.exportSchema(schema),
    loaders: new Map(
      relative
        .filter(
          ([file]) =>
            isFunctionModule(file) &&
            !nested.some((dir) => file.startsWith(dir)),
        )
        .map(([file, load]) => [file.replace(/\.[^.]+$/, ""), load]),
    ),
    loaded: new Map(),
    standing: new Set(standing),
  };
};

const entryExtensions = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
];

/**
 * Whether Convex's bundler deploys this file as a function module, by the rule
 * `entryPoints` applies in `convex/src/bundler/index.ts` (1.49). A test file, a
 * schema, a config and `_generated` never reach the binary, so the kernel
 * neither loads them nor resolves a function in them.
 */
const isFunctionModule = (file: string): boolean => {
  const base = file.split("/").pop()!;
  return (
    entryExtensions.some((extension) => file.endsWith(extension)) &&
    !file.startsWith("_generated/") &&
    !base.startsWith(".") &&
    !base.startsWith("#") &&
    base !== "schema.ts" &&
    base !== "schema.js" &&
    (base.match(/\./g) ?? []).length <= 1 &&
    !file.includes(" ")
  );
};

const unregistered = (world: World, componentPath: string) => {
  const registered = [...world.components.keys()].filter((p) => p !== ROOT);
  return new Error(
    `Component "${componentPath}" is not registered on this test backend. ` +
      (registered.length === 0
        ? "No components have been registered."
        : `Registered components: ${registered.map((p) => `"${p}"`).join(", ")}.`),
  );
};

type FunctionAddress = {
  readonly name?: string | undefined;
  readonly reference?: string | undefined;
  readonly functionHandle?: string | undefined;
};

/**
 * Where an address points, read from the calling component.
 */
const functionPathOf = (
  address: FunctionAddress,
  from: string,
): FunctionPath => {
  if (address.functionHandle !== undefined) {
    return parseFunctionHandle(address.functionHandle);
  }
  if (address.name !== undefined) {
    return { udfPath: address.name, componentPath: from };
  }
  if (address.reference !== undefined) {
    // "_reference/childComponent/<child>/path/to/file/fn"
    const parts = address.reference.split("/");
    const child = parts[2]!;
    const rest = parts.slice(3);
    return {
      componentPath: from.length > 0 ? `${from}/${child}` : child,
      udfPath: `${rest.slice(0, -1).join("/")}:${rest[rest.length - 1]}`,
    };
  }
  throw new Error("Function address not supported");
};

const pathOfReference = (
  reference: FunctionReference<any, any, any, any> | string,
  from: string,
) =>
  functionPathOf(getFunctionAddress(reference as any) as FunctionAddress, from);

interface Resolved {
  readonly func: any;
  readonly handler: (ctx: any, args: any) => any;
  readonly args: ValidatorJSON;
  readonly returns: ValidatorJSON | null;
}

const kindCheck = {
  query: "isQuery",
  mutation: "isMutation",
  action: "isAction",
} as const;

/**
 * A test backend: its registered components and the kernel state they share.
 */
export class World {
  readonly components = new Map<string, Component>();
  state: Kernel.State = Kernel.empty;
  private opened: Promise<void> | undefined;
  private nextDocId = 10000;
  private lastCreationTime = 0;
  private nextQueryId = 1;
  private readonly queries = new Map<number, Iterator<any>>();
  private readonly holding = new Map<string, Held>();
  private nextAttemptId = 1;
  /**
   * The latest deadline time has been advanced to. The clock never reads
   * earlier.
   */
  private floor = Number.NEGATIVE_INFINITY;
  private readonly targets = new Map<DocumentId, Scheduling.Target>();

  constructor(
    schema: SchemaDefinition<GenericSchema, boolean> | null | undefined,
    modules: Modules,
    private readonly runtime: Kernel.KernelRuntime = Kernel.wallClock(),
  ) {
    installConvexGlobal();
    Clock.install(pinnedTime, () => executions.getStore() !== undefined);
    this.components.set(ROOT, makeComponent(ROOT, schema, modules));
  }

  register(
    componentPath: string,
    schema: SchemaDefinition<GenericSchema, boolean>,
    modules: Modules,
    standing: ReadonlyArray<string> = [],
  ) {
    if (this.opened !== undefined) {
      throw new KernelRefusal.RegisteredAfterOpen({
        componentPath,
        message: `Component "${componentPath}" was registered after the test backend opened. Register every component before the first call.`,
      });
    }
    this.components.set(
      componentPath,
      makeComponent(componentPath, schema, modules, standing),
    );
  }

  /**
   * Load every registered module of every component, once, before any function
   * runs, then check that each standing source names an exported function.
   */
  open(): Promise<void> {
    this.opened ??= Promise.all(
      Array.from(this.components.values(), (component) =>
        Promise.all(
          Array.from(component.loaders, ([path, load]) =>
            load().then((module) => component.loaded.set(path, module)),
          ),
        ),
      ),
    ).then(() => this.checkStanding());
    return this.opened;
  }

  /**
   * Refuse a standing source no module of its component exports.
   */
  private checkStanding() {
    for (const component of this.components.values()) {
      for (const name of component.standing) {
        const [modulePath, exportName = "default"] = name.split(":");
        const func = component.loaded.get(modulePath!)?.[exportName];
        if (func?.isMutation !== true && func?.isAction !== true) {
          throw new KernelRefusal.UnknownStandingSource({
            componentPath: component.path,
            name,
            message: `Component "${component.path}" declares "${name}" standing, but exports no mutation or action by that name. Name the self-rescheduling function as module:export.`,
          });
        }
      }
    }
  }

  /**
   * The kernel's time: the runtime's, never earlier than the latest deadline
   * time was advanced to.
   */
  now(): number {
    return Math.max(this.runtime.now(), this.floor);
  }

  private component(componentPath: string): Component {
    const component = this.components.get(componentPath);
    if (component === undefined) throw unregistered(this, componentPath);
    return component;
  }

  private resolve(functionPath: FunctionPath, kind: UdfType | "any"): Resolved {
    const [modulePath, maybeExport] = functionPath.udfPath.split(":") as [
      string,
      string | undefined,
    ];
    const exportName = maybeExport ?? "default";
    const component = this.component(functionPath.componentPath);
    const module = component.loaded.get(modulePath);
    if (module === undefined) {
      throw new Error(`Could not find module for: "${modulePath}"`);
    }
    const func = module[exportName];
    if (func === undefined) {
      throw new Error(
        `Expected a Convex function exported from module "${modulePath}" as \`${exportName}\`, but there is no such export.`,
      );
    }
    const handler = "_handler" in func ? func._handler : func;
    if (typeof handler !== "function") {
      throw new Error(
        `Expected a Convex function exported from module "${modulePath}" as \`${exportName}\`, but got: ${func}`,
      );
    }
    if (kind !== "any" && !func[kindCheck[kind]]) {
      throw new Error(
        `Expected a ${kind} function, but the function exported from module "${modulePath}" as \`${exportName}\` is not a ${kind}.`,
      );
    }
    const args = JSON.parse(func.exportArgs()) as ValidatorJSON;
    if (args.type !== "object" && args.type !== "any") {
      throw new Error(
        `Invalid JSON returned from ${modulePath}.js:${exportName}.exportArgs(): ` +
          `Args validator must be an object or any`,
      );
    }
    return { func, handler, args, returns: JSON.parse(func.exportReturns()) };
  }

  // Calls from the test.

  query(caller: Caller, reference: any, args: any): Promise<any> {
    return this.open().then(() => {
      const from = { caller, request: newRequest(caller) };
      return typeof reference === "function"
        ? this.runQuery(
            { componentPath: ROOT, udfPath: "inline" },
            { handler: reference, args: { type: "any" }, returns: null },
            args ?? {},
            from,
          )
        : this.queryAt(pathOfReference(reference, ROOT), args, from);
    });
  }

  mutation(caller: Caller, reference: any, args: any): Promise<any> {
    return this.open().then(() => {
      const from = { caller, request: newRequest(caller) };
      return typeof reference === "function"
        ? this.runMutation(
            { componentPath: ROOT, udfPath: "inline" },
            { handler: reference, args: { type: "any" }, returns: null },
            args ?? {},
            from,
          )
        : this.mutationAt(pathOfReference(reference, ROOT), args, from);
    });
  }

  action(caller: Caller, reference: any, args: any): Promise<any> {
    return this.open().then(() => {
      const from = { caller, request: newRequest(caller) };
      return typeof reference === "function"
        ? this.runAction(
            { componentPath: ROOT, udfPath: "inline" },
            { handler: reference, args: { type: "any" }, returns: null },
            args ?? {},
            from,
          )
        : this.actionAt(pathOfReference(reference, ROOT), args, from);
    });
  }

  run(
    caller: Caller,
    componentPath: string,
    handler: (ctx: any) => any,
  ): Promise<any> {
    return this.open().then(() => {
      this.component(componentPath);
      return this.runMutation(
        { componentPath, udfPath: "custom" },
        { handler, args: { type: "any" }, returns: null },
        {},
        { caller, request: newRequest(caller) },
      );
    });
  }

  // Held attempts.

  /**
   * Run a mutation to its commit point and hold it as attempt 1.
   */
  prepare(caller: Caller, reference: any, args: any): Promise<HeldAttempt> {
    return this.open().then(() => {
      const functionPath = pathOfReference(reference, ROOT);
      const resolved = this.resolve(functionPath, "mutation");
      validateFunctionArgs(resolved.args, args ?? {}, functionPath, false);
      return this.prepareMutation(
        functionPath,
        resolved,
        args,
        { caller, request: newRequest(caller) },
        1,
        Invocation.current(),
      ).then((held) => held.view);
    });
  }

  apply(id: string): Promise<KernelApply> {
    const held = this.holding.get(id);
    return held === undefined
      ? Promise.reject(
          new KernelRefusal.StaleAttempt({
            id,
            message: `The test kernel holds no attempt "${id}". It was already applied, or never prepared.`,
          }),
        )
      : this.applyHeld(held);
  }

  /**
   * The held attempts, oldest first.
   */
  held(): ReadonlyArray<HeldAttempt> {
    return Array.from(this.holding.values(), (held) => held.view);
  }

  // Subscribed queries.

  /**
   * Run a query at the latest commit as a subscription runs it, under `caller`,
   * and return its answer with every dependency it took. `time` pins the time
   * it reads, the kernel's time now by default. `journal` ends its paginated
   * read where an earlier run's ended.
   */
  subscribed(
    caller: Caller,
    reference: any,
    args: any,
    pinned: { readonly time?: number; readonly journal: string | null },
  ): Promise<QueryRun> {
    return this.open().then(() => {
      const functionPath = pathOfReference(reference, ROOT);
      const resolved = this.resolve(functionPath, "query");
      validateFunctionArgs(resolved.args, args ?? {}, functionPath, false);
      const top: TopQuery = {
        attempt: new KernelAttempt(this.state),
        pagination: { calls: 0, journal: pinned.journal, end: null },
        startTime: pinned.time,
      };
      const run = (outcome: Outcome): QueryRun => ({
        outcome,
        snapshot: top.attempt.snapshot.version,
        reads: top.attempt.reads,
        observedIdentity: top.attempt.observedIdentity,
        time: top.attempt.observedTime,
        journal: pinned.journal ?? top.pagination.end,
      });
      return this.runQuery(
        functionPath,
        resolved,
        args,
        { caller, request: newRequest(caller) },
        false,
        top,
      ).then(
        (value: Value) => run({ _tag: "returned", value }),
        (error: unknown) => run({ _tag: "failed", error }),
      );
    });
  }

  // Scheduled functions, on the kernel's clock.

  /**
   * The committed pending jobs, earliest deadline first.
   */
  jobs(): ReadonlyArray<Scheduling.Job> {
    return Scheduling.pending(this.state, this.targets).map(
      ({ id, componentPath, name, scheduledTime, standing }) => ({
        id,
        componentPath,
        name,
        scheduledTime,
        standing,
      }),
    );
  }

  /**
   * Move the clock forward `ms`, running every job whose deadline falls on the
   * way, in deadline order, each starting at its deadline. Jobs those jobs
   * schedule inside the window run too. `advance(0)` runs what is due now and
   * crosses no future deadline.
   */
  advance(ms: number, budget = defaultBudget): Promise<void> {
    return this.open().then(() => {
      const until = this.now() + ms;
      return this.walk(
        (pending) => pending.filter((job) => job.scheduledTime <= until),
        budget,
      ).then(() => this.raiseFloor(until));
    });
  }

  /**
   * Run jobs, earliest deadline first and each at its deadline, until only
   * standing jobs are pending. Every job run counts against `budget`.
   */
  drain(budget = defaultBudget): Promise<void> {
    return this.open().then(() =>
      this.walk((pending) => pending.filter((job) => !job.standing), budget),
    );
  }

  /**
   * Run the first of `select(pending)` until it is empty, moving the clock to
   * each job's deadline as it starts.
   */
  private walk(
    select: (pending: Array<Scheduling.Due>) => Array<Scheduling.Due>,
    budget: number,
  ): Promise<void> {
    const step = (ran: number): Promise<void> => {
      const left = select(Scheduling.pending(this.state, this.targets));
      const next = left[0];
      if (next === undefined) return Promise.resolve();
      if (ran === budget) {
        const pending = Scheduling.functions(left);
        return Promise.reject(
          new KernelRefusal.DrainBudgetExceeded({
            budget,
            pending,
            message: `Scheduled functions ran ${budget} jobs and work remains: ${pending
              .map(({ componentPath, name }) =>
                componentPath === ROOT ? name : `${name} in "${componentPath}"`,
              )
              .join(
                ", ",
              )}. A function that schedules its own next run never lets the drain end, so its kit declares it with registerComponent's \`standing\` option.`,
          }),
        );
      }
      this.raiseFloor(next.scheduledTime);
      return this.runJob(next).then(() => step(ran + 1));
    };
    return step(0);
  }

  private raiseFloor(to: number) {
    this.floor = Math.max(this.floor, to);
  }

  /**
   * Run one pending job as its own request, moving its row through in progress
   * to success or failed. `walk` picks it from the committed pending jobs and
   * starts it in the same turn, so no cancel can land in between. The job runs
   * as a fresh invocation of the world that scheduled it, whatever invocation
   * the drain itself runs under.
   */
  private runJob(job: Scheduling.Due): Promise<void> {
    this.commitNow((attempt) => {
      const doc = attempt.get(job.componentPath, job.id)!;
      attempt.write(job.componentPath, job.id, {
        ...doc,
        state: { kind: "inProgress" },
      });
    });
    const request = jobRequest(job.id);
    const from: From = { caller: anonymous, request };
    const run = () =>
      Promise.resolve().then(() => {
        const { func } = this.resolve(job.target, "any");
        return func.isQuery
          ? this.queryAt(job.target, job.args, from)
          : func.isMutation
            ? this.mutationAt(job.target, job.args, from)
            : this.actionAt(job.target, job.args, from);
      });
    return (
      job.world === undefined
        ? Invocation.unbound(run)
        : Invocation.bind(
            Invocation.fresh(job.world, job.target.componentPath, request),
            run,
          )
    )
      .then(
        (): Scheduling.JobState => ({ kind: "success" }),
        (error: unknown): Scheduling.JobState => ({
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((state) =>
        this.commitNow((attempt) => {
          const doc = attempt.get(job.componentPath, job.id);
          if (doc === null || Scheduling.stateOf(doc).kind !== "inProgress")
            return;
          attempt.write(job.componentPath, job.id, {
            ...doc,
            state,
            completedTime: this.now(),
          });
        }),
      );
  }

  /**
   * Write through a fresh attempt and publish it at once, as the scheduler does
   * for an action's schedule and a job's state. Nothing runs between the
   * snapshot and the commit, so no other commit can conflict with it.
   */
  private commitNow<A>(write: (attempt: KernelAttempt) => A): A {
    const attempt = new KernelAttempt(this.state);
    const result = write(attempt);
    this.publishWrites(attempt.writes());
    return result;
  }

  /**
   * Publish `writes` as the next commit, at the runtime's timestamp for it. No
   * writes publish nothing and ask the runtime for no timestamp, which answers
   * the latest commit's.
   */
  private publishWrites(writes: ReadonlyArray<Kernel.Write>): bigint {
    if (writes.length === 0) return this.state.commitTs;
    const commitTs = this.runtime.commitTs(this.state.version + 1);
    if (commitTs <= this.state.commitTs) {
      throw new KernelRefusal.CommitTsNotIncreasing({
        version: this.state.version + 1,
        previous: this.state.commitTs,
        commitTs,
        message: `The runtime answered commit timestamp ${commitTs} for version ${this.state.version + 1}, which is not greater than the previous commit's ${this.state.commitTs}.`,
      });
    }
    this.state = Kernel.apply(this.state, writes, commitTs);
    return commitTs;
  }

  /**
   * Write a pending job into `attempt`, so the job exists only once that
   * attempt publishes. A job that a standing function schedules, or that runs
   * one, is standing.
   */
  private scheduleJob(
    attempt: KernelAttempt,
    execution: Execution,
    args: any,
  ): DocumentId {
    const target = functionPathOf(args, execution.componentPath);
    this.component(target.componentPath);
    const jobArgs = jsonToConvex(args.args);
    if (hasPendingValues(jobArgs)) {
      throw new Error(
        `Invalid arguments for "${target.udfPath}": a scheduled function cannot take an unresolved placeholder value.`,
      );
    }
    const id = this.generateId(Scheduling.table);
    attempt.write(
      execution.componentPath,
      id,
      Scheduling.row(
        id,
        this.creationTime(execution.startTime),
        target.udfPath,
        jobArgs,
        args.ts * 1000,
      ),
    );
    this.targets.set(id, {
      functionPath: target,
      standing:
        this.isStanding({
          componentPath: execution.componentPath,
          udfPath: execution.udfPath,
        }) || this.isStanding(target),
      world: Invocation.current()?.world,
    });
    return id;
  }

  /**
   * Cancel a job that has not finished. A finished job stays as it ended.
   */
  private cancelJob(attempt: KernelAttempt, componentPath: string, id: any) {
    validateId(Scheduling.table, id);
    attempt.readDocument(componentPath, id);
    const doc = attempt.get(componentPath, id);
    if (doc === null) {
      throw new Error(`Patch on non-existent document with ID "${id}"`);
    }
    const { kind } = Scheduling.stateOf(doc);
    if (kind === "pending" || kind === "inProgress") {
      attempt.write(componentPath, id, { ...doc, state: { kind: "canceled" } });
    }
  }

  private isStanding({ componentPath, udfPath }: FunctionPath): boolean {
    return this.components.get(componentPath)?.standing.has(udfPath) ?? false;
  }

  // Calls by address, from the test or from a running function.

  private queryAt(
    functionPath: FunctionPath,
    args: any,
    from: From,
    snapshotOnly = false,
  ) {
    const resolved = this.resolve(functionPath, "query");
    validateFunctionArgs(
      resolved.args,
      args ?? {},
      functionPath,
      from.parent?.attempt !== undefined,
    );
    return this.runQuery(functionPath, resolved, args, from, snapshotOnly);
  }

  private mutationAt(functionPath: FunctionPath, args: any, from: From) {
    const resolved = this.resolve(functionPath, "mutation");
    validateFunctionArgs(
      resolved.args,
      args ?? {},
      functionPath,
      from.parent?.attempt !== undefined,
    );
    return this.runMutation(functionPath, resolved, args, from);
  }

  private actionAt(functionPath: FunctionPath, args: any, from: From) {
    const resolved = this.resolve(functionPath, "action");
    validateFunctionArgs(resolved.args, args ?? {}, functionPath, false);
    return this.runAction(functionPath, resolved, args, from);
  }

  // Runners.

  private execution(
    functionPath: FunctionPath,
    udfType: UdfType,
    attempt: KernelAttempt | undefined,
    from: From,
    pagination: Pagination | undefined,
    startTime?: number,
  ): Execution {
    // A function in a component runs with no identity, whoever called it, as
    // Convex gives a component no `ctx.auth` of the caller's. A nested call in
    // the host takes its parent's identity, even when that is none.
    const identity =
      functionPath.componentPath !== ROOT
        ? null
        : from.parent !== undefined
          ? from.parent.identity
          : from.caller.identity;
    return {
      world: this,
      componentPath: functionPath.componentPath,
      udfPath: functionPath.udfPath,
      udfType,
      attempt,
      identity,
      request: from.request,
      startTime:
        startTime ??
        (from.parent !== undefined && from.parent.udfType !== "action"
          ? from.parent.startTime
          : this.now()),
      pagination,
      turn: new Turn(),
    };
  }

  private runQuery(
    functionPath: FunctionPath,
    resolved: Pick<Resolved, "handler" | "args" | "returns">,
    args: any,
    from: From,
    snapshotOnly = false,
    top?: TopQuery,
  ): Promise<any> {
    const parentAttempt = from.parent?.attempt;
    const isNested = parentAttempt !== undefined;
    const attempt =
      top?.attempt ??
      (parentAttempt === undefined
        ? new KernelAttempt(this.state)
        : snapshotOnly
          ? new KernelAttempt(parentAttempt.snapshot)
          : parentAttempt);
    const execution = this.execution(
      functionPath,
      "query",
      attempt,
      from,
      top?.pagination ??
        ((isNested && from.parent?.pagination) || {
          calls: 0,
          journal: null,
          end: null,
        }),
      top?.startTime,
    );
    const q = queryGeneric({
      handler: (ctx: any, a: any) =>
        resolved.handler({ ...ctx, auth: queryAuth(execution) }, a),
    }) as unknown as { invokeQuery: (args: string) => Promise<string> };
    return enter(execution, () =>
      q.invokeQuery(JSON.stringify(convexToJson([parseArgs(args)]))),
    )
      .then((raw) => settled(execution, raw))
      .then((raw) => {
        const result = jsonToConvex(JSON.parse(raw));
        if (!isNested && hasPendingValues(result)) {
          throw new Error(
            `Function ${functionPath.udfPath} return value invalid: queries ` +
              `cannot return an unresolved placeholder value.`,
          );
        }
        validateReturnValue(resolved.returns, result, "query", functionPath);
        return result;
      })
      .catch((error: unknown) => {
        throw deserializeConvexErrorData(error);
      });
  }

  private invokeMutation(
    execution: Execution,
    resolved: Pick<Resolved, "handler" | "returns">,
    args: any,
  ): Promise<Value> {
    const m = mutationGeneric({
      handler: (ctx: any, a: any) =>
        resolved.handler({ ...ctx, auth: mutationAuth(execution) }, a),
    }) as unknown as { invokeMutation: (args: string) => Promise<string> };
    return enter(execution, () =>
      m.invokeMutation(JSON.stringify(convexToJson([parseArgs(args)]))),
    )
      .then((raw) => settled(execution, raw))
      .then((raw) => {
        const result = jsonToConvex(JSON.parse(raw));
        validateReturnValue(resolved.returns, result, "mutation", {
          componentPath: execution.componentPath,
          udfPath: execution.udfPath,
        });
        return result;
      });
  }

  private runMutation(
    functionPath: FunctionPath,
    resolved: Pick<Resolved, "handler" | "args" | "returns">,
    args: any,
    from: From,
  ): Promise<any> {
    const parentAttempt = from.parent?.attempt;
    if (parentAttempt !== undefined) {
      const frame = parentAttempt.child();
      const execution = this.execution(
        functionPath,
        "mutation",
        frame,
        from,
        undefined,
      );
      // As at the top level, a nested mutation ends once its function has
      // returned and every syscall it started has settled. Convex runs a
      // nested function's syscall queue to the end before it commits its
      // subtransaction, so a detached fiber's late write lands in this frame
      // and merges with it. A failed one ends at once and rolls back.
      return this.invokeMutation(execution, resolved, args).then(
        (result) =>
          frame.drained().then(() => {
            frame.close();
            frame.merge();
            return result;
          }),
        (error: unknown) => {
          frame.close();
          throw deserializeConvexErrorData(error);
        },
      );
    }
    return this.prepareMutation(
      functionPath,
      resolved,
      args,
      from,
      1,
      Invocation.current(),
    ).then((held) => this.publish(held));
  }

  /**
   * Run one attempt of a top-level mutation against the latest commit, then
   * hold it. The commit point is once the function has returned and every
   * syscall it started has settled. A test invocation bound when the mutation
   * was first called reaches each attempt's handler with that attempt's
   * number.
   */
  private prepareMutation(
    functionPath: FunctionPath,
    resolved: Pick<Resolved, "handler" | "returns">,
    args: any,
    from: From,
    number: Invocation.Attempt,
    bound: Invocation.Invocation | undefined,
  ): Promise<Held> {
    const attempt = new KernelAttempt(this.state, number);
    const execution = this.execution(
      functionPath,
      "mutation",
      attempt,
      from,
      undefined,
    );
    const run = () => this.invokeMutation(execution, resolved, args);
    const started =
      bound === undefined
        ? run()
        : Invocation.bind({ ...bound, attempt: number }, run);
    return started
      .then(
        (value) =>
          attempt.drained().then((): Outcome => ({ _tag: "returned", value })),
        (error: unknown): Outcome => ({
          _tag: "failed",
          error: deserializeConvexErrorData(error),
        }),
      )
      .then((outcome) => {
        attempt.close();
        const held: Held = {
          view: {
            id: `attempt-${this.nextAttemptId++}`,
            request: from.request.requestId,
            number,
            snapshot: attempt.snapshot.version,
            reads: attempt.reads,
            outcome,
          },
          attempt,
          again: (next) =>
            this.prepareMutation(
              functionPath,
              resolved,
              args,
              from,
              next,
              bound,
            ),
        };
        this.holding.set(held.view.id, held);
        return held;
      });
  }

  /**
   * Validate a held attempt's reads against every commit since its snapshot,
   * then publish its writes or prepare its next attempt. An attempt that wrote
   * nothing publishes nothing and has nothing to validate. It answers its
   * snapshot's version and commit timestamp.
   */
  private applyHeld({ view, attempt, again }: Held): Promise<KernelApply> {
    this.holding.delete(view.id);
    const { outcome } = view;
    if (outcome._tag === "failed") {
      return Promise.resolve({
        kind: "refused",
        tag: tagOf(outcome.error),
        error: outcome.error,
      });
    }
    const writes = attempt.writes();
    if (writes.length === 0) {
      // As on the binary, a mutation that wrote nothing is serialized at its
      // snapshot and allocates no timestamp for a later commit.
      const { version, commitTs } = attempt.snapshot;
      return Promise.resolve({
        kind: "applied",
        version,
        commitTs,
        result: resolveCommittedValues(outcome.value, commitTs),
      });
    }
    if (
      Kernel.conflict(this.state, view.snapshot, attempt.reads) !== undefined
    ) {
      if (view.number === lastAttempt) {
        return Promise.resolve({
          kind: "exhausted",
          error: new KernelRefusal.OptimisticConcurrencyControlFailure({
            attempts: lastAttempt,
            message: `Documents read by the mutation changed before each of its ${lastAttempt} attempts could commit.`,
          }),
        });
      }
      return again((view.number + 1) as Invocation.Attempt).then(
        (next): KernelApply => ({ kind: "conflict", next: next.view }),
      );
    }
    // Validation, publication and the version read share one synchronous turn,
    // so no other commit lands between them.
    let commitTs: bigint;
    try {
      commitTs = this.publishWrites(writes);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve({
      kind: "applied",
      version: this.state.version,
      commitTs,
      result: resolveCommittedValues(outcome.value, commitTs),
    });
  }

  /**
   * Apply until the mutation publishes, is refused or is exhausted, as the
   * binary retries a mutation that conflicts.
   */
  private publish(held: Held): Promise<Value> {
    return this.applyHeld(held).then((applied) => {
      if (applied.kind === "applied") return applied.result;
      if (applied.kind === "conflict") {
        return this.publish(this.holding.get(applied.next.id)!);
      }
      throw applied.error;
    });
  }

  private runAction(
    functionPath: FunctionPath,
    resolved: Pick<Resolved, "handler" | "args" | "returns">,
    args: any,
    from: From,
  ): Promise<any> {
    const execution = this.execution(
      functionPath,
      "action",
      undefined,
      from,
      undefined,
    );
    const inner: From = { request: from.request, parent: execution };
    const a = actionGeneric({
      handler: (ctx: any, innerArgs: any) =>
        resolved.handler(
          {
            ...ctx,
            runQuery: (reference: any, queryArgs: any) =>
              this.queryAt(
                pathOfReference(reference, functionPath.componentPath),
                queryArgs,
                inner,
              ),
            runMutation: (reference: any, mutationArgs: any) =>
              this.mutationAt(
                pathOfReference(reference, functionPath.componentPath),
                mutationArgs,
                inner,
              ),
            runAction: (reference: any, actionArgs: any) =>
              this.actionAt(
                pathOfReference(reference, functionPath.componentPath),
                actionArgs,
                inner,
              ),
            auth: queryAuth(execution),
          },
          innerArgs,
        ),
    }) as unknown as {
      invokeAction: (requestId: string, args: string) => Promise<string>;
    };
    const run = () =>
      enter(execution, () =>
        a.invokeAction(
          from.request.requestId,
          JSON.stringify(convexToJson([parseArgs(args)])),
        ),
      );
    // An action another function calls is an invocation of its own, with its
    // world's services, a start time read from its world's clock and its
    // world's random stream, as a scheduled job is.
    const bound = from.parent === undefined ? undefined : Invocation.current();
    const started =
      bound === undefined
        ? run()
        : Invocation.bind(
            Invocation.fresh(
              bound.world,
              functionPath.componentPath,
              from.request,
            ),
            run,
          );
    return started
      .then((raw) => {
        const result = jsonToConvex(JSON.parse(raw));
        validateReturnValue(resolved.returns, result, "action", functionPath);
        return result;
      })
      .catch((error: unknown) => {
        throw deserializeConvexErrorData(error);
      });
  }

  // Syscalls.

  private schema(componentPath: string) {
    return this.component(componentPath).schema;
  }

  private view(execution: Execution): KernelQuery.TableView {
    const attempt = transaction(execution);
    return {
      schema: this.schema(execution.componentPath),
      scan: (tableName) => attempt.scan(execution.componentPath, tableName),
      read: (interval, after) =>
        attempt.readInterval({
          ...interval,
          componentPath: execution.componentPath,
          after,
        }),
    };
  }

  private generateId(table: string): DocumentId {
    const counter = String(this.nextDocId++).padStart(
      TYPICAL_CONVEX_ID_LENGTH - table.length,
      "0",
    );
    return (counter + table) as DocumentId;
  }

  syscall(op: string, jsonArgs: string): string {
    const args = JSON.parse(jsonArgs);
    const execution = current();
    if (execution.attempt?.closed === true) throw closed(execution, op);
    switch (op) {
      case "1.0/getSnapshotTs":
        return JSON.stringify(
          convexToJson(transaction(execution).snapshot.commitTs),
        );
      case "1.0/queryStream": {
        // The binary reads a query at each `1.0/queryStreamNext`, which waits
        // its turn in the queue, so the stream opens at its first read and sees
        // every write made before it.
        const queryId = this.nextQueryId++;
        const view = this.view(execution);
        let results: Iterator<any> | undefined;
        this.queries.set(queryId, {
          next: () => (results ??= KernelQuery.stream(view, args.query)).next(),
        });
        return JSON.stringify({ queryId });
      }
      case "1.0/queryCleanup":
        this.queries.delete(args.queryId);
        return JSON.stringify({});
      case "1.0/db/normalizeId": {
        const tableName = tableNameFromId(args.idString);
        return JSON.stringify({
          id: tableName === args.table ? args.idString : null,
        });
      }
      default:
        throw new Error(`The test kernel does not support syscall: "${op}"`);
    }
  }

  /**
   * The binary queues a query's or mutation's async syscalls and runs them one
   * at a time, oldest first (`start_async_syscall` and `run_inner` in
   * `crates/isolate/src/environment/udf/mod.rs`, 1.49). A write and a nested
   * call never share a batch (`AsyncSyscallBatch::can_push` in
   * `async_syscall.rs`), and a nested call holds the queue until it has
   * committed or rolled back its subtransaction (`run_udf` in
   * `async_syscall.rs`). So a caller's write made after its nested call runs
   * after that call, and a nested mutation sees every write made before it. An
   * action's calls run side by side.
   */
  asyncSyscall(op: string, jsonArgs: string): Promise<string> {
    const execution = current();
    const attempt = execution.attempt;
    if (attempt === undefined) {
      return Promise.resolve().then(() =>
        this.dispatchAsync(op, JSON.parse(jsonArgs), execution),
      );
    }
    if (attempt.closed) return Promise.reject(closed(execution, op));
    // A syscall counts toward its frame's lifetime from the moment it is
    // queued, so a frame never closes with a write still waiting its turn.
    const end = attempt.begin();
    return execution.turn
      .take(() => this.dispatchAsync(op, JSON.parse(jsonArgs), execution))
      .finally(end);
  }

  private dispatchAsync(
    op: string,
    args: any,
    execution: Execution,
  ): string | Promise<string> {
    switch (op) {
      case "1.0/get": {
        const { table, id } = args;
        return JSON.stringify(convexToJson(this.get(execution, table, id)));
      }
      case "1.0/queryStreamNext": {
        const results = this.queries.get(args.queryId);
        if (results === undefined) throw new Error("Bad queryId");
        const { value, done } = results.next();
        return JSON.stringify(
          convexToJson(
            done ? { value: null, done: true } : { value, done: false },
          ),
        );
      }
      case "1.0/queryPage": {
        const pagination = execution.pagination;
        if (pagination) {
          pagination.calls += 1;
          if (pagination.calls > 1) {
            throw new Error(
              "Only a single paginated query (`.paginate()`) is allowed per " +
                "query, including nested query calls and component calls. " +
                "This is a Convex limit: https://docs.convex.dev/database/pagination",
            );
          }
        }
        const page = KernelQuery.paginate(this.view(execution), {
          ...args,
          endCursor: args.endCursor ?? pagination?.journal ?? null,
        });
        if (pagination) pagination.end = page.continueCursor;
        return JSON.stringify(convexToJson(page as any));
      }
      case "1.0/insert":
        return JSON.stringify({
          _id: this.insert(execution, args.table, jsonToConvex(args.value)),
        });
      case "1.0/shallowMerge":
        this.patch(execution, args.table, args.id, args.value);
        return JSON.stringify({});
      case "1.0/replace":
        this.replace(execution, args.table, args.id, args.value);
        return JSON.stringify({});
      case "1.0/remove":
        this.remove(execution, args.table, args.id);
        return JSON.stringify({});
      case "1.0/count": {
        const attempt = transaction(execution);
        attempt.readInterval({
          kind: "interval",
          componentPath: execution.componentPath,
          table: args.table,
          fields: ["_creationTime", "_id"],
          order: "asc",
          range: [],
          after: null,
        })("end");
        return JSON.stringify(
          attempt.scan(execution.componentPath, args.table).length,
        );
      }
      case "1.0/getFunctionMetadata":
        return JSON.stringify(
          convexToJson({
            name: execution.udfPath,
            componentPath: execution.componentPath,
          }),
        );
      case "1.0/getRequestMetadata":
        if (execution.udfType === "query") {
          throw new Error(
            "getRequestMetadata() can only be called from a mutation, action " +
              "or HTTP action. It is not available in queries.",
          );
        }
        return JSON.stringify(convexToJson(execution.request as any));
      case "1.0/getDeploymentMetadata":
        return JSON.stringify(
          convexToJson({ name: "test", region: null, class: "s16" }),
        );
      case "1.0/actions/query":
      case "1.0/actions/mutation":
      case "1.0/actions/action": {
        const from: From = { request: execution.request, parent: execution };
        const functionPath = functionPathOf(args, execution.componentPath);
        const run =
          op === "1.0/actions/query"
            ? this.queryAt(functionPath, args.args, from)
            : op === "1.0/actions/mutation"
              ? this.mutationAt(functionPath, args.args, from)
              : this.actionAt(functionPath, args.args, from);
        return run.then((value) => JSON.stringify(convexToJson(value)));
      }
      case "1.0/runUdf": {
        const { udfType, args: udfArgs } = args;
        const from: From = { request: execution.request, parent: execution };
        const functionPath = functionPathOf(args, execution.componentPath);
        const value = jsonToConvex(udfArgs);
        const run =
          udfType === "query"
            ? this.queryAt(functionPath, value, from)
            : udfType === "snapshotQuery"
              ? this.queryAt(functionPath, value, from, true)
              : udfType === "mutation"
                ? this.mutationAt(functionPath, value, from)
                : Promise.reject(
                    new Error(
                      `The test kernel does not support udf type: "${udfType}"`,
                    ),
                  );
        return run.then((result) => JSON.stringify(convexToJson(result)));
      }
      case "1.0/createFunctionHandle": {
        const functionPath = functionPathOf(args, execution.componentPath);
        this.component(functionPath.componentPath);
        return JSON.stringify(createFunctionHandle(functionPath));
      }
      case "1.0/auditLog":
        return JSON.stringify(null);
      case "1.0/schedule":
        return JSON.stringify(
          convexToJson(
            this.scheduleJob(transaction(execution), execution, args),
          ),
        );
      case "1.0/actions/schedule":
        return JSON.stringify(
          convexToJson(
            this.commitNow((attempt) =>
              this.scheduleJob(attempt, execution, args),
            ),
          ),
        );
      case "1.0/cancel_job":
        this.cancelJob(
          transaction(execution),
          execution.componentPath,
          args.id,
        );
        return JSON.stringify({});
      case "1.0/actions/cancel_job":
        this.commitNow((attempt) =>
          this.cancelJob(attempt, execution.componentPath, args.id),
        );
        return JSON.stringify({});
      case "1.0/storageDelete":
      case "1.0/storageGetUrl":
      case "1.0/storageGenerateUploadUrl":
        throw KernelRefusal.rowPending("storage", 6);
      case "1.0/getTransactionMetrics":
        throw KernelRefusal.rowPending("transaction limits", 6);
      case "1.0/actions/vectorSearch":
        throw KernelRefusal.requiresBinary("vectorSearch");
      default:
        throw new Error(
          `The test kernel does not support async syscall: "${op}"`,
        );
    }
  }

  jsSyscall(op: string): Promise<never> {
    return Promise.reject(
      op.startsWith("storage/")
        ? KernelRefusal.rowPending("storage", 6)
        : new Error(`The test kernel does not support js syscall: "${op}"`),
    );
  }

  // Documents. The checks and messages are convex-test's.

  private get(execution: Execution, tableName: unknown, id: unknown) {
    validateId(tableName, id);
    const attempt = transaction(execution);
    attempt.readDocument(execution.componentPath, id);
    return attempt.get(execution.componentPath, id);
  }

  private insert(execution: Execution, table: string, value: any): DocumentId {
    const attempt = transaction(execution);
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      table,
      value,
    );
    const _id = this.generateId(table);
    attempt.write(execution.componentPath, _id, {
      ...value,
      _id,
      _creationTime: this.creationTime(execution.startTime),
    });
    return _id;
  }

  /**
   * A new document's creation time: `at`, or just past the latest one, so no
   * two documents share one.
   */
  private creationTime(at: number): number {
    const time =
      at <= this.lastCreationTime ? this.lastCreationTime + 0.001 : at;
    this.lastCreationTime = time;
    return time;
  }

  private existing(
    execution: Execution,
    tableName: unknown,
    id: unknown,
    write: string,
    value: unknown,
  ): StoredDocument {
    validateId(tableName, id);
    if (value !== undefined && typeof value !== "object") {
      throw new Error(
        `Invalid argument \`value\` in \`db.${write}\`, expected object but got '${typeof value}': ${value as any}`,
      );
    }
    const attempt = transaction(execution);
    attempt.readDocument(execution.componentPath, id);
    const document = attempt.get(execution.componentPath, id);
    if (document === null) {
      throw new Error(
        write === "delete"
          ? "Delete on non-existent doc"
          : `${write === "patch" ? "Patch" : "Replace"} on non-existent document with ID "${id}"`,
      );
    }
    return document;
  }

  private fields(document: StoredDocument, value: Record<string, any>) {
    if (value._id !== undefined && value._id !== document._id) {
      throw new Error(
        `Provided \`_id\` field value "${value._id}" ` +
          `does not match the document ID "${document._id}"`,
      );
    }
    if (
      value._creationTime !== undefined &&
      value._creationTime !== document._creationTime
    ) {
      throw new Error(
        `Provided \`_creationTime\` field value ${value._creationTime} ` +
          `does not match the document's creation time ${document._creationTime}`,
      );
    }
    const convexValue: Record<string, Value | undefined> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key !== "_id" && key !== "_creationTime") {
        convexValue[key] = evaluateValue(v);
      }
    }
    return convexValue;
  }

  private patch(
    execution: Execution,
    tableName: unknown,
    id: unknown,
    value: Record<string, any>,
  ) {
    const document = this.existing(execution, tableName, id, "patch", value);
    const { _id, _creationTime, ...fields } = document;
    const merged = { ...fields, ...this.fields(document, value) };
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      tableNameFromId(_id)!,
      merged,
    );
    transaction(execution).write(execution.componentPath, _id, {
      _id,
      _creationTime,
      ...merged,
    } as StoredDocument);
  }

  private replace(
    execution: Execution,
    tableName: unknown,
    id: unknown,
    value: Record<string, any>,
  ) {
    const document = this.existing(execution, tableName, id, "replace", value);
    const fields = this.fields(document, value);
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      tableNameFromId(document._id)!,
      fields,
    );
    transaction(execution).write(execution.componentPath, document._id, {
      ...fields,
      _id: document._id,
      _creationTime: document._creationTime,
    } as StoredDocument);
  }

  private remove(execution: Execution, tableName: unknown, id: unknown) {
    const document = this.existing(
      execution,
      tableName,
      id,
      "delete",
      undefined,
    );
    transaction(execution).write(execution.componentPath, document._id, null);
  }
}

/**
 * Where a call comes from. A call from the test carries its accessor's caller.
 * A nested call carries its parent execution and takes its identity from it.
 */
type From =
  | {
      readonly caller: Caller;
      readonly request: Request;
      readonly parent?: undefined;
    }
  | { readonly parent: Execution; readonly request: Request };

const closed = (execution: Execution, operation: string) =>
  new KernelRefusal.ClosedAttempt({
    operation,
    message: `"${operation}" reached mutation ${execution.udfPath} after it returned and its syscalls settled. Await every read and write inside the handler.`,
  });

const transaction = (execution: Execution): KernelAttempt => {
  if (execution.attempt === undefined) {
    throw new Error(
      "The database is only available in queries and mutations. An action reads and writes through `ctx.runQuery` and `ctx.runMutation`.",
    );
  }
  return execution.attempt;
};

const queryAuth = (execution: Execution) => ({
  getUserIdentity: () => {
    execution.attempt?.observeIdentity();
    return Promise.resolve(execution.identity);
  },
});

const mutationAuth = (execution: Execution) => ({
  ...queryAuth(execution),
  signJwt: () => Promise.reject(KernelRefusal.rowPending("JWT signing", 6)),
});

function validateId(
  expectedTableName: unknown,
  id: unknown,
): asserts id is DocumentId {
  if (typeof id !== "string") {
    throw new Error(
      `Invalid argument \`id\`, expected string but got '${typeof id}': ${id as any}`,
    );
  }
  if (expectedTableName === undefined) return;
  if (typeof expectedTableName !== "string") {
    throw new Error(
      `Invalid argument \`tableName\`, expected string but got '${typeof expectedTableName}': ${expectedTableName as any}`,
    );
  }
  const actualTableName = tableNameFromId(id);
  if (actualTableName === null) {
    throw new Error(
      `Invalid argument \`id\`, expected ID value but got '${id}'`,
    );
  }
  if (actualTableName !== expectedTableName) {
    throw new Error(
      `Invalid argument \`id\`, expected ID in table '${expectedTableName}' but got ID in table '${actualTableName}'`,
    );
  }
}

interface Syscalls {
  readonly syscall: (op: string, args: string) => string;
  readonly asyncSyscall: (op: string, args: string) => Promise<string>;
  readonly jsSyscall: (op: string, args: unknown) => unknown;
}

type Branded = { readonly [kernelBrand]?: true };

/**
 * The backend another library installed as `globalThis.Convex`, which answers
 * every syscall made outside a kernel function.
 */
let forwarded: Syscalls | undefined;

// With neither, `current` refuses the syscall.
const backend = (): Syscalls =>
  executions.getStore()?.world ?? forwarded ?? current().world;

const dispatcher: Syscalls & Branded = {
  [kernelBrand]: true,
  syscall: (op, args) => backend().syscall(op, args),
  asyncSyscall: (op, args) => backend().asyncSyscall(op, args),
  jsSyscall: (op, args) => backend().jsSyscall(op, args),
};

/**
 * Convex's server library reaches the backend through `globalThis.Convex`, one
 * global for the whole test runtime. convex-test 0.0.65 assigns its own the
 * first time it builds a world (its `dist/index.js:1936-1951`), whenever that
 * is. The kernel keeps the global an accessor that always reads its dispatcher,
 * and takes an assignment, or the global it found, as the backend for syscalls
 * made outside a kernel function. So a kernel world and a convex-test world
 * stay live together, whichever was built first, and no world restores the
 * global when it ends. A test that redefines the global removes the accessor,
 * so every kernel function installs it again over what the test left.
 */
const installConvexGlobal = () => {
  const found = (globalThis as { Convex?: Syscalls & Branded }).Convex;
  if (found?.[kernelBrand] === true) return;
  forwarded = found;
  Object.defineProperty(globalThis, "Convex", {
    get: () => dispatcher,
    set: (value: (Syscalls & Branded) | undefined) => {
      if (value?.[kernelBrand] !== true) forwarded = value;
    },
    configurable: true,
    enumerable: true,
  });
};

/**
 * Whether `globalThis.Convex` is the kernel's, and no other backend installed
 * one behind it.
 */
export const ownsConvexGlobal = (): boolean =>
  (globalThis as { Convex?: Branded }).Convex?.[kernelBrand] === true &&
  forwarded === undefined;
