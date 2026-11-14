import { AsyncLocalStorage } from "node:async_hooks";
import {
  actionGeneric,
  getFunctionAddress,
  httpActionGeneric,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericSchema,
  type SchemaDefinition,
  type UserIdentity,
} from "convex/server";
import {
  Base64,
  CommitTsPlaceholder,
  compareValues,
  convexToJson,
  jsonToConvex,
  type JSONValue,
  type Value,
} from "convex/values";
import * as Result from "effect/Result";
import { KernelAttempt } from "./Attempt.js";
import * as Clock from "./Clock.js";
import * as Crons from "./Crons.js";
import * as Globals from "./Globals.js";
import * as Identity from "./Identity.js";
import * as Http from "./Http.js";
import * as Invocation from "./Invocation.js";
import * as IoBans from "./IoBans.js";
import * as Kernel from "./Kernel.js";
import * as KernelQuery from "./KernelQuery.js";
import * as KernelRefusal from "./KernelRefusal.js";
import * as Metering from "./Metering.js";
import type * as ReadSet from "./ReadSet.js";
import * as Redaction from "./Redaction.js";
import * as Scheduling from "./Scheduling.js";
import * as Storage from "./Storage.js";
import * as Snapshot from "./Snapshot.js";
import type {
  ConvexErrorDataEncoding,
  DocumentId,
  FunctionPath,
  StoredDocument,
  ValidatorJSON,
} from "./KernelValues.js";
import {
  createFunctionHandle,
  createTestJwt,
  evaluateValue,
  hasPendingValues,
  isSimpleObject,
  parseArgs,
  parseFunctionHandle,
  receiveConvexErrorData,
  resolveCommittedValues,
  simpleHash,
  tableNameFromId,
  validateFunctionArgs,
  validateReturnValue,
} from "./KernelValues.js";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Json from "./Json.js";

const ROOT = "";

/**
 * A cron job's declaration as a snapshot writes it and a restore compares it:
 * its name, function, arguments as Convex JSON through `args`, and schedule, a
 * cron expression by its text.
 */
const declarationJson = (
  { spec }: Pick<CronJob, "spec">,
  args: (json: JSONValue) => JSONValue,
) => ({
  name: spec.name,
  udfPath: spec.udfPath,
  args: args(convexToJson(spec.args)),
  schedule: (spec.schedule.kind === "cron"
    ? { kind: "cron", expression: spec.schedule.expression }
    : spec.schedule) as unknown as JSONValue,
});

const cronKey = (componentPath: string, name: string) =>
  `${componentPath}\u0000${name}`;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const TYPICAL_CONVEX_ID_LENGTH = 32;

type Modules = Record<string, () => Promise<any>>;

/**
 * Each module's source as text, such as `import.meta.glob(pattern, { query:
 * "?raw", import: "default" })` of the same files gives, matched to its module
 * by its path below the directory that holds `_generated`.
 */
type Sources = Record<string, () => Promise<string>>;

/**
 * The runtime a test declares for a component's plain Convex actions, by
 * component path, when it cannot give the component's sources: a package's test
 * kit registers its modules without them.
 */
export type ComponentRuntimes = Readonly<Record<string, IoBans.Runtime>>;

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
  /**
   * Each function module's source, when the test supplied them, so its `"use
   * node"` directive decides its runtime as the bundler's does.
   */
  readonly sources: ReadonlyMap<string, () => Promise<string>> | undefined;
  /**
   * Each loaded module's runtime, read from its source when the world opens.
   */
  readonly runtimes: Map<string, IoBans.Runtime>;
  /**
   * The `auth.config` module beside the functions, which only the app's
   * providers come from.
   */
  readonly authConfig: (() => Promise<any>) | undefined;
}

/**
 * Who is calling: the identity and the request attributes a test accessor set.
 */
/**
 * A declared cron job and its next run. The binary keeps this in the
 * component's `_cron_jobs` and `_cron_next_run` system tables, which no
 * function reads, so the kernel keeps it beside its tables.
 */
export interface CronJob {
  readonly componentPath: string;
  readonly spec: Crons.Spec;
  readonly nextRun: number;
  readonly last: CronOutcome | undefined;
  /**
   * The world bound when the test backend opened, which the binary's push
   * stands for. Each run starts as a fresh invocation of it, or unbound.
   */
  readonly world: Invocation.World | undefined;
}

/**
 * A cron job as its component declares it, before any run is scheduled.
 */
interface CronDeclaration {
  readonly componentPath: string;
  readonly spec: Crons.Spec;
}

export type CronOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failed"; readonly error: string };

/**
 * A declared cron job as a driver sees it.
 */
export interface Cron {
  readonly componentPath: string;
  readonly name: string;
  readonly udfPath: string;
  readonly nextRun: number;
  /**
   * How the latest run ended, as the binary's cron log records it.
   */
  readonly last: CronOutcome | undefined;
}

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
  const subject = identity.subject ?? "" + simpleHash(Json.stringify(identity));
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
  /**
   * The mutation the attempt runs, whose return shape marks its outcome in an
   * artifact.
   */
  readonly functionPath: FunctionPath;
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
  readonly runtime: IoBans.Runtime;
  readonly attempt: KernelAttempt | undefined;
  readonly identity: UserIdentity | null;
  /**
   * The verifier's refusal of the token its request presented, when an HTTP
   * request's token was refused. The binary runs the request with an unknown
   * identity that holds the error
   * (`local_backend/src/http_actions.rs:165-169`), and a nested call in the
   * host gets that identity unchanged (`model/src/components/auth.rs:6-19`).
   */
  readonly unverified: KernelRefusal.InvalidToken | undefined;
  readonly request: Request;
  /**
   * The kernel's time when the outermost query or mutation began. Its nested
   * calls share it, and `Date` answers it inside them.
   */
  readonly startTime: number;
  readonly pagination: Pagination | undefined;
  readonly turn: Turn;
  /**
   * The transaction limits this function runs under: the defaults at the top
   * level, its caller's inside a nested call, tightened by the call's budget.
   */
  readonly limits: Metering.Limits;
  /**
   * The first kernel refusal a syscall of this call, or of a call nested in it,
   * threw. Convex's `performAsyncSyscall` rethrows a syscall's error as a plain
   * `Error`, so the refusal is kept here for whatever must surface it, such as
   * an HTTP route that would otherwise answer 500.
   */
  readonly refused: { first?: unknown };
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
 * The error a host API ended each function with, such as a timer a query
 * started, and the signal that ends it. On the binary that function stops at
 * its next microtask checkpoint and fails with the error, whatever its handler
 * caught, and whether or not the handler ever settles.
 */
interface Ending {
  readonly ended: Promise<never>;
  readonly end: (error: unknown) => void;
}

const endings = new WeakMap<Execution, Ending>();

const endingOf = (execution: Execution): Ending => {
  let ending = endings.get(execution);
  if (ending === undefined) {
    const { promise, reject } = Promise.withResolvers<never>();
    // Read only through `unlessEnded`, so an ending nothing awaits is no
    // unhandled rejection.
    promise.catch(() => undefined);
    ending = { ended: promise, end: reject };
    endings.set(execution, ending);
  }
  return ending;
};

const ioHooks: IoBans.Hooks = {
  running: () => executions.getStore(),
  end: (error) => {
    const execution = executions.getStore();
    if (execution !== undefined) endingOf(execution).end(error);
  },
};

/**
 * `outcome`, unless a host API ended `execution` first, in which case its
 * ending, without waiting for the handler to settle.
 */
const unlessEnded = <A>(execution: Execution, outcome: Promise<A>) =>
  Promise.race([outcome, endingOf(execution).ended]);

const installIoBans = (): ReadonlyArray<string> => {
  const unguarded = IoBans.install();
  IoBans.bind(ioHooks);
  return unguarded;
};

/**
 * Run a function's code as `execution`, with its own copy of the globals a test
 * invocation pins, and the host APIs Convex refuses refused. A test that fakes
 * `Date` after the backend opened replaced the kernel's wrapper, so each
 * function wraps the realm's `Date` again, as it installs `globalThis.Convex`
 * again. A guarded global a test replaced is adopted beneath a fresh guard
 * first, and one that cannot be guarded refuses the function before it runs.
 */
const enter = <A>(execution: Execution, run: () => A): A => {
  installConvexGlobal();
  installDate();
  // A function runs only with every banned global guarded.
  const unguarded = installIoBans();
  if (unguarded.length > 0) throw KernelRefusal.unguardableGlobal(unguarded);
  watches.set(execution, IoBans.watch());
  return Globals.own(() => executions.run(execution, run));
};

/**
 * What tells, at each function's settlement, which guarded globals were
 * redefined since its entry.
 */
const watches = new WeakMap<Execution, () => ReadonlyArray<string>>();

/**
 * `outcome`, unless a guarded global was redefined while `execution` ran. A
 * guard cannot stop a call made through a replacement, which a descriptor
 * change such as `Object.defineProperty` makes, so the change is caught when
 * the function settles: it fails with `UnguardableGlobal`, whatever it
 * returned, and the guard is installed again. Applied before a mutation's
 * commit point, so it publishes none of its writes.
 */
const unlessReplaced = <A>(
  execution: Execution,
  outcome: Promise<A>,
): Promise<A> => {
  const refusal = () => {
    const names = watches.get(execution)?.() ?? [];
    if (names.length === 0) return undefined;
    installIoBans();
    return KernelRefusal.replacedWhileRunning(execution.udfPath, names);
  };
  return outcome.then(
    (value) => {
      const refused = refusal();
      if (refused !== undefined) throw refused;
      return value;
    },
    (error: unknown) => {
      throw refusal() ?? error;
    },
  );
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

const installDate = () =>
  Clock.install(pinnedTime, () => executions.getStore() !== undefined);

/**
 * How many jobs one drain or advance runs before it gives up, as convex-test's
 * `finishAllScheduledFunctions` defaults to.
 */
const defaultBudget = 100;

const unresolvedWorld = (
  name: string,
  reason: "missing" | "ambiguous",
): KernelRefusal.SnapshotWorldUnresolved =>
  KernelRefusal.SnapshotWorldUnresolved.make({
    worldName: name,
    reason,
    message:
      reason === "missing"
        ? `A snapshot job runs under the test world "${name}", which no world passed to restore is named. Pass that world.`
        : `Two different test worlds are named "${name}", so a snapshot cannot tell their jobs apart. Name each world uniquely.`,
  });

/**
 * `shape` placed at `at`, or no placement when there is no shape.
 */
const placed = (
  shape: Redaction.Shape | undefined,
  at: ReadonlyArray<string> = [],
): ReadonlyArray<Redaction.Placement> =>
  shape === undefined ? [] : [{ at, shape }];

const running = (
  registry: KernelRefusal.SnapshotWorldRunning["registry"],
  count: number,
  what: string,
) =>
  KernelRefusal.SnapshotWorldRunning.make({
    registry,
    count,
    message: `The test backend is running ${count} ${what}, whose effects a snapshot would split. Await them first.`,
  });

const current = (): Execution => {
  const execution = executions.getStore();
  if (execution === undefined) {
    throw new Error(
      "A Convex syscall ran outside any function the test kernel started.",
    );
  }
  return execution;
};

/**
 * A request ID in the binary's format, 16 lowercase hex digits
 * (`RequestId::new` in `crates/common/src/execution_context.rs:204-208`,
 * convex-backend `cccbade4`). The binary draws 8 random bytes. The kernel
 * counts instead, so every request in the process gets its own ID and a replay
 * draws nothing from the supplied random stream.
 */
let nextRequestId = 0;
const newRequest = (caller: Caller): Request => ({
  ip: caller.ip,
  userAgent: caller.userAgent,
  requestId: Str.padStart(16, "0")((nextRequestId++).toString(16)),
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
  const generated = Option.getOrUndefined(
    Arr.findFirst(paths, (path) => pipe(path, Str.includes("_generated"))),
  );
  if (generated === undefined) {
    throw new Error(
      'Could not find the "_generated" directory, make sure to run ' +
        "`npx convex dev` or `npx convex codegen`. Make sure your " +
        '`import.meta.glob` includes the files in the "_generated" directory',
    );
  }
  return pipe(generated, Str.split("_generated"))[0];
};

const makeComponent = (
  path: string,
  schema: SchemaDefinition<GenericSchema, boolean> | null | undefined,
  modules: Modules,
  standing: ReadonlyArray<string> = [],
  sources?: Sources,
): Component => {
  const root = findModulesRoot(Rec.keys(modules));
  const relative = pipe(
    Rec.toEntries(modules),
    Arr.filter(([key]) => pipe(key, Str.startsWith(root))),
    Arr.map(
      ([key, load]) => [pipe(key, Str.slice(root.length)), load] as const,
    ),
  );
  // Sources are matched to modules by their path below their own modules
  // root, so a `?raw` glob of the same files from another file, whose keys
  // carry another prefix, matches too.
  const sourcesRoot =
    sources === undefined
      ? root
      : pipe(
          Arr.findFirst(Rec.keys(sources), (key) =>
            pipe(key, Str.includes("_generated")),
          ),
          Option.match({
            onNone: () => root,
            onSome: (key) => pipe(key, Str.split("_generated"))[0],
          }),
        );
  const relativeSources =
    sources === undefined
      ? undefined
      : new Map(
          pipe(
            Rec.toEntries(sources),
            Arr.filter(([key]) => pipe(key, Str.startsWith(sourcesRoot))),
            Arr.map(
              ([key, read]) =>
                [
                  pipe(
                    key,
                    Str.slice(sourcesRoot.length),
                    Str.replace(/\.[^.]+$/, ""),
                  ),
                  read,
                ] as const,
            ),
          ),
        );
  const nested = pipe(
    relative,
    Arr.map(([file]) => file),
    Arr.filter((file) => pipe(file, Str.endsWith("/convex.config.ts"))),
    Arr.map((file) => pipe(file, Str.slice(0, -"convex.config.ts".length))),
  );
  return {
    path,
    schema: KernelQuery.exportSchema(schema),
    loaders: new Map(
      pipe(
        relative,
        Arr.filter(
          ([file]) =>
            isFunctionModule(file) &&
            !Arr.some(nested, (dir) => pipe(file, Str.startsWith(dir))),
        ),
        Arr.map(([file, load]) => [
          pipe(file, Str.replace(/\.[^.]+$/, "")),
          load,
        ]),
      ),
    ),
    loaded: new Map(),
    standing: new Set(standing),
    sources: relativeSources,
    runtimes: new Map(),
    authConfig: Option.getOrUndefined(
      Arr.findFirst(relative, ([file]) => /^auth\.config\.[jt]s$/.test(file)),
    )?.[1],
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
  const base = pipe(file, Str.split("/")).pop()!;
  return (
    Arr.some(entryExtensions, (extension) =>
      pipe(file, Str.endsWith(extension)),
    ) &&
    !pipe(file, Str.startsWith("_generated/")) &&
    !pipe(base, Str.startsWith(".")) &&
    !pipe(base, Str.startsWith("#")) &&
    base !== "schema.ts" &&
    base !== "schema.js" &&
    pipe(
      base,
      Str.match(/\./g),
      Option.match({ onNone: () => 0, onSome: (dots) => dots.length }),
    ) <= 1 &&
    !pipe(file, Str.includes(" "))
  );
};

/**
 * Whether `source` opens with a `"use node"` directive: a string-literal
 * statement in its directive prologue, which is what the bundler reads
 * (`hasUseNodeDirective`, `npm-packages/convex/src/bundler/index.ts:508-548`,
 * at the local backend's `cccbade4`, which takes Babel's `program.directives`).
 * Comments and a hashbang may come before it.
 */
export const hasUseNodeDirective = (source: string): boolean => {
  if (!pipe(source, Str.includes("use node"))) return false;
  let at = 0;
  const rest = () => pipe(source, Str.slice(at));
  // The offset of `token` in the rest of the source, past `from`, or its end.
  const past = (token: string, from: number) =>
    pipe(
      rest(),
      Str.slice(from),
      Str.indexOf(token),
      Option.match({
        onNone: () => source.length - at,
        onSome: (index) => from + index,
      }),
    );
  const skipTrivia = (newlines: boolean) => {
    for (;;) {
      const space = newlines ? /^\s+/.exec(rest()) : /^[ \t]+/.exec(rest());
      if (space !== null) {
        at += space[0].length;
      } else if (
        pipe(rest(), Str.startsWith("//")) ||
        (at === 0 && pipe(rest(), Str.startsWith("#!")))
      ) {
        if (!newlines) return;
        at += past("\n", 0);
      } else if (pipe(rest(), Str.startsWith("/*"))) {
        at = Math.min(source.length, at + past("*/", 2) + 2);
      } else {
        return;
      }
    }
  };
  for (;;) {
    skipTrivia(true);
    const quote = source[at];
    if (quote !== '"' && quote !== "'") return false;
    let end = at + 1;
    while (end < source.length && source[end] !== quote) {
      end += source[end] === "\\" ? 2 : 1;
    }
    if (end >= source.length) return false;
    const value = pipe(source, Str.slice(at + 1, end));
    at = end + 1;
    skipTrivia(false);
    // A directive is a whole statement: the literal ends at `;`, a line end,
    // the end of the file, or a comment that runs to one.
    const next = source[at];
    const ended =
      next === undefined ||
      next === ";" ||
      next === "\n" ||
      next === "\r" ||
      pipe(rest(), Str.startsWith("//")) ||
      pipe(rest(), Str.startsWith("/*"));
    if (!ended) return false;
    if (value === "use node") return true;
    if (next === ";") at += 1;
  }
};

/**
 * Modules the bundler refuses to run in Node (`mustBeIsolate`,
 * `bundler/index.ts:551-556`).
 */
const mustBeIsolate = (path: string) =>
  ["http", "crons", "schema", "auth.config"].includes(path);

/**
 * The runtime of the module at `path`, read from the source the test supplied:
 * `"node"` for a `"use node"` directive, else `"isolate"`, as the bundler's
 * `determineEnvironment` decides (`bundler/index.ts:558-588`). `undefined` when
 * the test supplied no sources for the component.
 */
const runtimeFromSource = (
  component: Component,
  path: string,
): Promise<IoBans.Runtime | undefined> => {
  if (component.sources === undefined) return Promise.resolve(undefined);
  const read = component.sources.get(path);
  if (read === undefined) {
    return Promise.reject(
      KernelRefusal.ModuleRuntime.make({
        reason: "missingSource",
        componentPath: component.path,
        module: path,
        message: `Module "${path}" has no source among the sources the test gave${component.path === ROOT ? "" : ` component "${component.path}"`}, so its "use node" directive cannot be read. Give a source for every module, as a ?raw glob of the same files does.`,
      }),
    );
  }
  return read().then((source) => {
    if (!hasUseNodeDirective(source)) return "isolate";
    if (mustBeIsolate(path)) {
      throw KernelRefusal.ModuleRuntime.make({
        reason: "nodeNotAllowed",
        componentPath: component.path,
        module: path,
        message: `"use node" directive is not allowed for ${path}.`,
      });
    }
    return "node";
  });
};

/**
 * The runtime Confect registered an action for: `true` for a Node action
 * (`RegisteredNodeFunction.make` in `@confect/server`), `false` for an isolate
 * one (`RegisteredConvexFunction`). A plain Convex function has no mark.
 */
const nodeAction = Symbol.for("@confect/server/NodeAction");

const markOf = (func: unknown): boolean | undefined =>
  (func as { [nodeAction]?: boolean } | undefined)?.[nodeAction];

/**
 * The runtime a function runs in: its module's, read from the directive. With
 * no source, Confect's mark decides, then the runtime the test declared for the
 * component, and an action with none of these was refused when the world
 * opened. A mark that disagrees with the directive is refused.
 */
const runtimeOfFunction = (
  component: Component,
  modulePath: string,
  exportName: string,
  func: unknown,
  componentRuntime: IoBans.Runtime | undefined,
): IoBans.Runtime => {
  const marked = markOf(func);
  const declared = component.runtimes.get(modulePath);
  if (declared === undefined) {
    if (marked !== undefined) return marked ? "node" : "isolate";
    return componentRuntime ?? "isolate";
  }
  if (marked !== undefined && marked !== (declared === "node")) {
    throw KernelRefusal.ModuleRuntime.make({
      reason: "markerDisagrees",
      componentPath: component.path,
      module: modulePath,
      message: marked
        ? `${modulePath}:${exportName} is a Confect Node action, but module "${modulePath}" has no "use node" directive, so Convex would run it in its isolate.`
        : `${modulePath}:${exportName} is a Confect action for Convex's isolate, but module "${modulePath}" has a "use node" directive, so Convex would run it in Node. Register it as a Node action.`,
    });
  }
  return declared;
};

/**
 * Refuse a component the test gave no sources, and declared no runtime for,
 * whose modules export an action with no Confect mark: Convex runs it in Node
 * or in its isolate by its module's `"use node"` directive, which only a source
 * shows.
 */
const checkActionRuntimes = (
  component: Component,
  componentRuntime: IoBans.Runtime | undefined,
) => {
  if (component.sources !== undefined || componentRuntime !== undefined) return;
  for (const [path, module] of component.loaded) {
    const unknown = pipe(
      Rec.toEntries((module ?? {}) as Record<string, unknown>),
      Arr.filter(
        ([, func]) =>
          (func as { isAction?: unknown } | undefined)?.isAction === true &&
          markOf(func) === undefined,
      ),
      Arr.map(([name]) => name),
    );
    const named = Arr.join(
      Arr.map(unknown, (name) => `${path}:${name}`),
      ", ",
    );
    if (unknown.length > 0) {
      throw KernelRefusal.ActionRuntimeUnknown.make({
        componentPath: component.path,
        module: path,
        exports: unknown,
        message:
          `Module "${path}"${component.path === ROOT ? "" : ` of component "${component.path}"`} exports ${named}, a plain Convex action, and the test gave no sources, so the test kernel cannot read the module's "use node" directive to tell whether Convex runs it in Node or in its isolate. ` +
          (component.path === ROOT
            ? `Pass the modules' sources, such as import.meta.glob(pattern, { query: "?raw", import: "default" }) of the same files.`
            : `Pass the component's sources, as registerComponent(name, schema, modules, { sources }), or, for a package's test kit that registers without them, declare the runtime its plain actions run in with componentRuntimes: { "${component.path}": "isolate" }.`),
      });
    }
  }
};

const unregistered = (world: World, componentPath: string) => {
  const registered = Arr.filter(
    [...world.components.keys()],
    (p) => p !== ROOT,
  );
  return new Error(
    `Component "${componentPath}" is not registered on this test backend. ` +
      (registered.length === 0
        ? "No components have been registered."
        : `Registered components: ${pipe(
            registered,
            Arr.map((p) => `"${p}"`),
            Arr.join(", "),
          )}.`),
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
    const parts = pipe(address.reference, Str.split("/"));
    const child = parts[2]!;
    const rest = parts.slice(3);
    return {
      componentPath: from.length > 0 ? `${from}/${child}` : child,
      udfPath: `${Arr.join(rest.slice(0, -1), "/")}:${rest[rest.length - 1]}`,
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
  readonly runtime: IoBans.Runtime;
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
  private readonly files = new Map<DocumentId, Storage.File>();
  private readonly legacyIds = new Map<string, DocumentId>();
  private nextFile = 1;
  private nextUploadToken = 1;
  private nextErrorRequest = 1;
  private readonly cronJobs = new Map<string, CronJob>();
  /**
   * Every component's cron declarations, read once the modules load.
   */
  private declared: ReadonlyArray<CronDeclaration> = [];
  /**
   * Whether the declared jobs have their runs: first runs scheduled, or a
   * snapshot's installed.
   */
  private cronsScheduled = false;
  /**
   * The raw secrets this world has seen under a secret schema node. Replay
   * state, kept in memory and never written to an artifact.
   */
  private secrets = new Redaction.Secrets();
  /**
   * The live registries `Snapshot.contract.live` names, each a count: calls
   * from the test, scheduler walks, function executions (nested and detached
   * ones included), open sync sockets and registered subscribers. Held attempts
   * are `holding`.
   */
  private readonly live = {
    running: 0,
    walks: 0,
    functions: 0,
    sockets: 0,
    subscribers: 0,
  };
  /**
   * Listeners `Sync` registers, told after each commit publishes, so a socket
   * whose queries the commit invalidated sends its client a transition.
   */
  private readonly watchers = new Set<() => void>();
  /**
   * The latest identity version a subscriber's `authenticate` reached. Each
   * subscriber starts at the epoch, and each identity change advances it, so a
   * restored world never hands out a version its source already used.
   */
  private identityEpoch = 0;
  /**
   * The default export of the app's `auth.config`, loaded at open.
   */
  private authConfig: Promise<unknown> = Promise.resolve(undefined);
  private providers: ReadonlyArray<Identity.Provider> | undefined;
  readonly deploymentKey = new Identity.DeploymentKey(() =>
    this.drawSigningSeed(),
  );

  constructor(
    schema: SchemaDefinition<GenericSchema, boolean> | null | undefined,
    modules: Modules,
    private readonly runtime: Kernel.KernelRuntime = Kernel.wallClock(),
    private readonly redaction: Redaction.Policy = Redaction.none,
    /**
     * The world the driver gives the backend itself, which a backend opened
     * with no invocation bound declares its cron jobs in.
     */
    private readonly own?: Invocation.World,
    sources?: Sources,
    private readonly componentRuntimes: ComponentRuntimes = {},
  ) {
    installConvexGlobal();
    installDate();
    installIoBans();
    this.components.set(
      ROOT,
      makeComponent(ROOT, schema, modules, [], sources),
    );
  }

  register(
    componentPath: string,
    schema: SchemaDefinition<GenericSchema, boolean>,
    modules: Modules,
    standing: ReadonlyArray<string> = [],
    sources?: Sources,
  ) {
    if (this.opened !== undefined) {
      throw KernelRefusal.RegisteredAfterOpen.make({
        componentPath,
        message: `Component "${componentPath}" was registered after the test backend opened. Register every component before the first call.`,
      });
    }
    this.components.set(
      componentPath,
      makeComponent(componentPath, schema, modules, standing, sources),
    );
  }

  /**
   * Load every registered module, with its runtime read from its source when
   * the test supplied them, refuse a plain Convex action whose runtime no
   * source shows, read each component's cron declarations, and schedule their
   * first runs, once. The first runs start in the world of the invocation bound
   * by the call that opened the backend, or else the world the driver gave the
   * backend. `advance` and `drain` open with the driver's, since their binding
   * never reaches a job.
   */
  open(): Promise<void> {
    return this.openIn(Invocation.current()?.world ?? this.own);
  }

  private openIn(world: Invocation.World | undefined): Promise<void> {
    return this.load().then(() => this.scheduleFirstRuns(world));
  }

  /**
   * Load every registered module of every component, once, before any function
   * runs, check that each standing source names an exported function, and read
   * each component's cron declarations. Nothing here draws a random value, so a
   * restore can load without one.
   */
  private load(): Promise<void> {
    if (this.opened === undefined) {
      const loadAuthConfig = this.component(ROOT).authConfig;
      this.authConfig =
        loadAuthConfig === undefined
          ? Promise.resolve(undefined)
          : loadAuthConfig().then((module) => module.default);
      this.opened = Promise.all([
        ...Array.from(this.components.values(), (component) =>
          Promise.all(
            Array.from(component.loaders, ([path, load]) =>
              Promise.all([load(), runtimeFromSource(component, path)]).then(
                ([module, runtime]) => {
                  component.loaded.set(path, module);
                  if (runtime !== undefined)
                    component.runtimes.set(path, runtime);
                  return undefined;
                },
              ),
            ),
          ),
        ),
        this.authConfig,
      ])
        .then(() => {
          for (const component of this.components.values()) {
            checkActionRuntimes(
              component,
              this.componentRuntimeOf(component.path),
            );
          }
          return this.checkStanding();
        })
        .then(() => this.readDeclarations());
    }
    return this.opened;
  }

  /**
   * Open the backend, and the caller a call from the test runs as: `caller`, or
   * the one a presented `token` makes. Each call from the test reaches its
   * caller inside its own `during`, so verifying a token and running the call
   * are one live call, and a snapshot refuses while either is pending.
   */
  private presenting(
    caller: Caller,
    token: string | undefined,
  ): Promise<Caller> {
    return token === undefined
      ? this.open().then(() => caller)
      : this.authenticate(caller, token);
  }

  /**
   * The caller `token` makes from `caller`, as a sync session's Authenticate
   * presents it: verified against the app's `auth.config` providers at the
   * kernel's time, as one live call, so a snapshot refuses while it is
   * pending.
   */
  verify(caller: Caller, token: string): Promise<Caller> {
    return this.during(() => this.authenticate(caller, token));
  }

  /**
   * The caller a presented token makes, verified against the app's
   * `auth.config` providers at the kernel's time, before anything runs. The
   * binary verifies a client's token on every request, so a token that expires
   * fails the next call after it does.
   */
  private authenticate(caller: Caller, token: string): Promise<Caller> {
    return this.open()
      .then(() => this.authConfig)
      .then((config) => {
        this.providers ??= Identity.readProviders(config);
        return Identity.verify(token, this.providers, this.now());
      })
      .then((identity) => ({ ...caller, identity, token }));
  }

  /**
   * The deployment signing key's seed: 32 values from the random stream of the
   * invocation's world bound now, or else the backend's own, as a cron delay
   * draws. The seed is kept as a secret, so a snapshot writes it as a marker
   * and no artifact shows it raw.
   */
  private drawSigningSeed(): Identity.Seed {
    const world = Invocation.current()?.world ?? this.own;
    if (world === undefined) {
      throw KernelRefusal.SigningKeyRandomUnavailable.make({
        message:
          "The deployment's signing key is drawn from a test world's random stream, and no invocation is bound and this backend was given no world to draw it from. The kernel holds no generator. Pass `world` to `convexTest`, or use `TestConfect.layer`'s kernel target, whose world is seeded.",
      });
    }
    const seed = pipe(
      Arr.makeBy(32, () =>
        pipe(
          Math.floor(world.random() * 256).toString(16),
          Str.padStart(2, "0"),
        ),
      ),
      Arr.join(""),
    );
    this.secrets.keep(seed);
    return seed;
  }

  private readDeclarations() {
    this.declared = this.readCrons();
  }

  /**
   * Read each component's `crons.ts` as the binary reads `crons.js` at push
   * (`crates/model/src/cron_jobs/mod.rs:151-195`) and refuse what the push
   * would (`crates/isolate/src/environment/analyze.rs:1016-1089`,
   * `crates/application/src/application_function_runner/mod.rs:1932-1979`).
   * Jobs come in name order, as the binary walks them.
   */
  private readCrons(): ReadonlyArray<CronDeclaration> {
    const declarations: Array<CronDeclaration> = [];
    for (const component of this.components.values()) {
      const module = component.loaded.get("crons");
      if (module === undefined) continue;
      const refuse = (message: string) =>
        KernelRefusal.InvalidCron.make({
          componentPath: component.path,
          cronName: "",
          message,
        });
      if (!("default" in module)) {
        throw refuse(
          "`convex/crons.js` must have a default export of a Crons object.",
        );
      }
      const declared = module.default;
      if (declared?.isCrons !== true || typeof declared.export !== "function") {
        throw refuse(
          "The default export of `convex/crons.js` is not a Crons object.",
        );
      }
      const exported = Json.parse(declared.export()) as Record<string, unknown>;
      for (const name of Rec.keys(exported).sort()) {
        const parsed = Crons.parseSpec(component.path, name, exported[name]);
        if (Result.isFailure(parsed)) throw parsed.failure;
        this.checkCronTarget(component, parsed.success);
        declarations.push({
          componentPath: component.path,
          spec: parsed.success,
        });
      }
    }
    return declarations;
  }

  /**
   * Schedule each declared job's first run from the kernel's time now, once, in
   * `world`. A clock schedule draws its delay from `world`'s random stream, so
   * with no world it is refused. A restore installs the snapshot's runs instead
   * and never comes here.
   */
  private scheduleFirstRuns(world: Invocation.World | undefined) {
    if (this.cronsScheduled) return;
    const scheduled = new Map<string, CronJob>();
    for (const { componentPath, spec } of this.declared) {
      if (spec.schedule.kind !== "interval" && world === undefined) {
        throw KernelRefusal.CronRandomUnavailable.make({
          componentPath,
          cronName: spec.name,
          message: `Cron job "${spec.name}" runs on a ${spec.schedule.kind} schedule, which Convex delays by a random number of seconds, and no test world was bound when the backend opened to draw it from. The kernel holds no generator. Open the backend under a bound invocation, whose world's random stream the delay draws from.`,
        });
      }
      const job: CronJob = {
        componentPath,
        spec,
        nextRun: 0,
        last: undefined,
        world,
      };
      scheduled.set(cronKey(componentPath, spec.name), {
        ...job,
        nextRun: this.searched(
          job,
          Crons.nextRun(spec.schedule, undefined, this.now(), (bound) =>
            this.draw(job, bound),
          ),
        ),
      });
    }
    for (const [key, job] of scheduled) this.cronJobs.set(key, job);
    this.cronsScheduled = true;
  }

  /**
   * Refuse a cron job whose function is missing or is no mutation or action.
   */
  private checkCronTarget(component: Component, spec: Crons.Spec) {
    const [modulePath, exportName = "default"] = pipe(
      spec.udfPath,
      Str.split(":"),
    );
    const func = component.loaded.get(modulePath!)?.[exportName];
    const refuse = (reason: string) =>
      KernelRefusal.InvalidCron.make({
        componentPath: component.path,
        cronName: spec.name,
        message: `The cron job '${spec.name}' ${reason}: ${spec.udfPath}`,
      });
    if (func === undefined) {
      throw refuse("schedules a function that does not exist");
    }
    if (func.isQuery === true) {
      throw refuse(
        "schedules a query function, only actions and mutations can be scheduled",
      );
    }
    if (func.isHttp === true) {
      throw refuse(
        "schedules an HTTP action, only actions and mutations can be scheduled",
      );
    }
    if (func.isMutation !== true && func.isAction !== true) {
      throw refuse("schedules a function that does not exist");
    }
  }

  /**
   * A whole number in `[0, bound)`, drawn from the random stream of the world
   * the cron job runs in, the stream its handlers draw from. `declareCrons`
   * refused a clock schedule with no world, and an interval never draws.
   */
  private draw(cron: CronJob, bound: number): number {
    return Math.floor(cron.world!.random() * bound);
  }

  /**
   * A computed run time, or the refusal for a search the binary cannot finish.
   */
  private searched(
    cron: CronJob,
    result: Result.Result<number, Crons.SearchFailure>,
  ): number {
    if (Result.isSuccess(result)) return result.success;
    const { name, schedule } = cron.spec;
    const expression = schedule.kind === "cron" ? schedule.expression : name;
    throw result.failure._tag === "BinaryAborts"
      ? KernelRefusal.CronAbortsBinary.make({
          componentPath: cron.componentPath,
          cronName: name,
          date: result.failure.date,
          message: `Cron job "${name}" searches "${expression}" from ${result.failure.date}, a Monday, where saffron subtracts below zero (saffron/src/lib.rs:663). The Convex binary is built with overflow checks and aborts there, so the kernel refuses rather than answer.`,
        })
      : new Error(
          `Cron job "${name}" has no next run, though its schedule passed saffron's \`any\` when it was read.`,
        );
  }

  /**
   * Refuse a standing source no module of its component exports.
   */
  private checkStanding() {
    for (const component of this.components.values()) {
      for (const name of component.standing) {
        const [modulePath, exportName = "default"] = pipe(name, Str.split(":"));
        const func = component.loaded.get(modulePath!)?.[exportName];
        if (func?.isMutation !== true && func?.isAction !== true) {
          throw KernelRefusal.UnknownStandingSource.make({
            componentPath: component.path,
            functionName: name,
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

  /**
   * The runtime the test declared for the component at `componentPath`, read
   * from the declaration's own entries only, so a component named like an
   * `Object.prototype` member, such as `constructor`, declares nothing unless
   * the test lists it.
   */
  private componentRuntimeOf(
    componentPath: string,
  ): IoBans.Runtime | undefined {
    return Option.getOrUndefined(
      Rec.get(this.componentRuntimes, componentPath),
    );
  }

  private component(componentPath: string): Component {
    const component = this.components.get(componentPath);
    if (component === undefined) throw unregistered(this, componentPath);
    return component;
  }

  private resolve(functionPath: FunctionPath, kind: UdfType | "any"): Resolved {
    const [modulePath, maybeExport] = pipe(
      functionPath.udfPath,
      Str.split(":"),
    ) as [string, string | undefined];
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
    if (kind !== "any" && func[kindCheck[kind]] !== true) {
      throw new Error(
        `Expected a ${kind} function, but the function exported from module "${modulePath}" as \`${exportName}\` is not a ${kind}.`,
      );
    }
    const args = Json.parse(func.exportArgs()) as ValidatorJSON;
    if (args.type !== "object" && args.type !== "any") {
      throw new Error(
        `Invalid JSON returned from ${modulePath}.js:${exportName}.exportArgs(): ` +
          `Args validator must be an object or any`,
      );
    }
    return {
      func,
      handler,
      args,
      returns: Json.parse(func.exportReturns()),
      runtime: runtimeOfFunction(
        component,
        modulePath,
        exportName,
        func,
        this.componentRuntimeOf(component.path),
      ),
    };
  }

  // Calls from the test.

  query(
    caller: Caller,
    reference: any,
    args: any,
    token?: string,
  ): Promise<any> {
    return this.during(() =>
      this.presenting(caller, token).then((who) => {
        const from = { caller: who, request: newRequest(who) };
        return typeof reference === "function"
          ? this.runQuery(
              { componentPath: ROOT, udfPath: "inline" },
              { handler: reference, args: { type: "any" }, returns: null },
              args ?? {},
              from,
            )
          : this.queryAt(pathOfReference(reference, ROOT), args, from);
      }),
    );
  }

  mutation(
    caller: Caller,
    reference: any,
    args: any,
    token?: string,
  ): Promise<any> {
    return this.during(() =>
      this.presenting(caller, token).then((who) => {
        const from = { caller: who, request: newRequest(who) };
        return typeof reference === "function"
          ? this.runMutation(
              { componentPath: ROOT, udfPath: "inline" },
              { handler: reference, args: { type: "any" }, returns: null },
              args ?? {},
              from,
            )
          : this.mutationAt(pathOfReference(reference, ROOT), args, from);
      }),
    );
  }

  action(
    caller: Caller,
    reference: any,
    args: any,
    token?: string,
  ): Promise<any> {
    return this.during(() =>
      this.presenting(caller, token).then((who) => {
        const from = { caller: who, request: newRequest(who) };
        return typeof reference === "function"
          ? this.runAction(
              { componentPath: ROOT, udfPath: "inline" },
              { handler: reference, args: { type: "any" }, returns: null },
              args ?? {},
              from,
            )
          : this.actionAt(pathOfReference(reference, ROOT), args, from);
      }),
    );
  }

  run(
    caller: Caller,
    componentPath: string,
    handler: (ctx: any) => any,
    token?: string,
  ): Promise<any> {
    return this.during(() =>
      this.presenting(caller, token).then((who) => {
        this.component(componentPath);
        return this.runMutation(
          { componentPath, udfPath: "custom" },
          { handler, args: { type: "any" }, returns: null },
          {},
          { caller: who, request: newRequest(who) },
        );
      }),
    );
  }

  /**
   * Send `path` to the root component's HTTP router, as the binary routes a
   * request: the router's `lookup` picks the route by pathname and method, and
   * the route's handler runs as an action with the caller's identity. With no
   * route, the binary's 404, and for a handler that throws, its 500.
   *
   * A presented `token` is verified first, in the same live call. A token the
   * verifier refuses does not refuse the request: the binary runs the handler
   * with an unknown identity that holds the error
   * (`local_backend/src/http_actions.rs:165-169`), and the handler's
   * `getUserIdentity` throws it.
   */
  fetch(
    caller: Caller,
    path: unknown,
    init?: RequestInit,
    token?: string,
  ): Promise<Response> {
    return this.during(() =>
      this.presenting(caller, token).then(
        (verified) => this.route(verified, path, init),
        (error: unknown) => {
          if (!KernelRefusal.isInvalidToken(error)) throw error;
          // The request runs as the binary's unknown identity: no user, no
          // token to forward (`keybroker/src/broker.rs:165-175`), and the
          // refusal for an action's `getUserIdentity` to throw.
          return this.route(
            { ...caller, identity: null, token: null },
            path,
            init,
            error,
          );
        },
      ),
    );
  }

  private route(
    caller: Caller,
    path: unknown,
    init: RequestInit | undefined,
    refused?: KernelRefusal.InvalidToken,
  ): Promise<Response> {
    const url = orThrow(Http.requestUrl(path));
    const method = init?.method ?? "GET";
    const request = new Request(
      url,
      Http.discardsBody(method) ? { ...init, body: null } : init,
    );
    const router = this.component(ROOT).loaded.get("http")?.["default"] as
      | {
          readonly lookup: (
            path: string,
            method: string,
          ) => readonly [any, string, string] | null;
        }
      | undefined;
    const route = router?.lookup(url.pathname, request.method) ?? null;
    if (route === null) {
      return Promise.resolve(Http.forMethod(request.method, Http.noRoute()));
    }
    const [endpoint] = route;
    const handler: (
      ctx: any,
      request: globalThis.Request,
    ) => Promise<Response> =
      "_handler" in endpoint ? endpoint._handler : endpoint;
    const execution = this.execution(
      { componentPath: ROOT, udfPath: "http" },
      "action",
      undefined,
      { caller, request: newRequest(caller), unverified: refused },
      undefined,
    );
    const action = httpActionGeneric((ctx, received) =>
      handler({ ...ctx, auth: queryAuth(execution) }, received),
    ) as unknown as {
      invokeHttpAction: (request: globalThis.Request) => Promise<Response>;
    };
    // A handler that throws gets the binary's 500, not a rejected fetch. A
    // kernel refusal is no handler error: it surfaces as itself.
    return this.track("functions", () =>
      enter(execution, () => action.invokeHttpAction(request)),
    ).then(
      (response) => Http.forMethod(request.method, response),
      (thrown: unknown) => {
        const refusal = refusalOf(thrown, execution);
        if (refusal !== undefined) throw refusal;
        // The report is an artifact, so it leaves through the failure
        // redaction a rejected call's report does.
        return Http.forMethod(
          request.method,
          Http.serverError(
            this.redactFailure(thrown),
            Http.errorRequestId(this.nextErrorRequest++),
          ),
        );
      },
    );
  }

  // Held attempts.

  /**
   * Run a mutation to its commit point and hold it as attempt 1.
   */
  prepare(
    caller: Caller,
    reference: any,
    args: any,
    token?: string,
  ): Promise<HeldAttempt> {
    return this.during(() =>
      this.presenting(caller, token).then((who) => {
        const functionPath = pathOfReference(reference, ROOT);
        const resolved = this.resolve(functionPath, "mutation");
        this.keepArgs(functionPath, args);
        validateFunctionArgs(resolved.args, args ?? {}, functionPath, false);
        return this.prepareMutation(
          functionPath,
          resolved,
          args,
          { caller: who, request: newRequest(who) },
          1,
          Invocation.current(),
        ).then((held) => held.view);
      }),
    );
  }

  apply(id: string): Promise<KernelApply> {
    return this.during(() => {
      const held = this.holding.get(id);
      return held === undefined
        ? Promise.reject(
            KernelRefusal.StaleAttempt.make({
              id,
              message: `The test kernel holds no attempt "${id}". It was already applied, or never prepared.`,
            }),
          )
        : this.applyHeld(held);
    });
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
    return this.during(() =>
      this.open().then(() => {
        const functionPath = pathOfReference(reference, ROOT);
        const resolved = this.resolve(functionPath, "query");
        this.keepArgs(functionPath, args);
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
      }),
    );
  }

  /**
   * Run `call`, a call from the test, counted as running until it settles.
   */
  private during<A>(call: () => Promise<A>): Promise<A> {
    return this.track("running", call);
  }

  /**
   * Run `work` counted in the live registry `registry` until it settles.
   */
  private track<A>(
    registry: "running" | "walks" | "functions",
    work: () => Promise<A>,
  ): Promise<A> {
    this.live[registry]++;
    const settle = () => {
      this.live[registry]--;
    };
    try {
      return work().finally(settle);
    } catch (error) {
      settle();
      throw error;
    }
  }

  /**
   * How many entries each live registry holds now.
   */
  liveCounts(): {
    readonly [K in keyof typeof Snapshot.contract.live]: number;
  } {
    return {
      running: this.live.running,
      walks: this.live.walks,
      functions: this.live.functions,
      held: this.holding.size,
      sockets: this.live.sockets,
      subscribers: this.live.subscribers,
    };
  }

  /**
   * Count a sync socket open until `close` is called.
   */
  openSocket(): { readonly close: () => void } {
    this.live.sockets++;
    let open = true;
    return {
      close: () => {
        if (open) this.live.sockets--;
        open = false;
      },
    };
  }

  /**
   * Call `listener` after each commit publishes, until the returned function is
   * called. It runs in the commit's turn, so it must only schedule work.
   */
  watch(listener: () => void): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  /**
   * Count a subscriber the shim's registry created. Subscribers live as long as
   * their test, so the count never falls.
   */
  registerSubscriber() {
    this.live.subscribers++;
  }

  // Identity versions.

  /**
   * The identity version a new subscriber starts at.
   */
  currentIdentityEpoch(): number {
    return this.identityEpoch;
  }

  /**
   * The next identity version, for a subscriber whose identity changed.
   */
  nextIdentityEpoch(): number {
    return ++this.identityEpoch;
  }

  // Snapshots.

  /**
   * The committed state as snapshot bytes: every component's rows and the
   * version that wrote each, the write log, the jobs and their targets, the
   * clock's floor and the identity counters. Each job's world is recorded by
   * name. Two exports of the same state are the same bytes. A world running a
   * call or holding attempts refuses, since a snapshot carries neither.
   */
  exportSnapshot(): Uint8Array {
    this.refuseBusy(0, "export");
    const names = new Map<string, Invocation.World>();
    const jobs = new Map<DocumentId, Snapshot.JobTarget>();
    for (const byTable of this.state.tables.values()) {
      for (const id of byTable.get(Scheduling.table)?.keys() ?? []) {
        const target = this.targets.get(id);
        if (target === undefined) continue;
        const world = target.world;
        if (world !== undefined) {
          if ((names.get(world.name) ?? world) !== world) {
            throw unresolvedWorld(world.name, "ambiguous");
          }
          names.set(world.name, world);
        }
        jobs.set(id, {
          functionPath: target.functionPath,
          standing: target.standing,
          world: world?.name ?? null,
        });
      }
    }
    // A file's bytes travel with its committed row. Bytes a rolled-back or
    // deleted file left behind are unreachable, so no export carries them.
    const files = new Map<DocumentId, Storage.File>();
    for (const byTable of this.state.tables.values()) {
      for (const id of byTable.get(Storage.table)?.keys() ?? []) {
        const file = this.files.get(id);
        if (file !== undefined) files.set(id, file);
      }
    }
    const crons = Array.from(this.cronJobs.values(), (cron) => {
      if (cron.world !== undefined) {
        if ((names.get(cron.world.name) ?? cron.world) !== cron.world) {
          throw unresolvedWorld(cron.world.name, "ambiguous");
        }
        names.set(cron.world.name, cron.world);
      }
      const target = {
        componentPath: cron.componentPath,
        udfPath: cron.spec.udfPath,
      };
      return {
        componentPath: cron.componentPath,
        ...declarationJson(cron, (json) =>
          Redaction.mark(
            json,
            placed(this.redaction.args(target)),
            this.secrets,
          ),
        ),
        nextRun: cron.nextRun,
        // A failure's text holds whatever the function threw, so a kept secret
        // in it is written as a marker a restore puts back.
        last:
          cron.last?.kind === "failed"
            ? {
                kind: "failed" as const,
                error: Redaction.mark(cron.last.error, [], this.secrets),
              }
            : (cron.last ?? null),
        world: cron.world?.name ?? null,
      };
    });
    return Snapshot.encode(
      {
        components: [...this.components.keys()],
        state: this.state,
        floor: this.floor,
        identity: {
          nextDocumentId: this.nextDocId,
          lastCreationTime: this.lastCreationTime,
          nextAttemptId: this.nextAttemptId,
          identityEpoch: this.identityEpoch,
          nextFile: this.nextFile,
          nextUploadToken: this.nextUploadToken,
        },
        jobs,
        files,
        crons,
        signingKey:
          this.deploymentKey.seed === undefined
            ? null
            : {
                [Redaction.markerKey]: this.secrets.keep(
                  this.deploymentKey.seed,
                ),
              },
      },
      (componentPath, table, json) =>
        Redaction.mark(
          json,
          this.documentPlacements(
            componentPath,
            table,
            json as { readonly _id: unknown; readonly name?: unknown },
          ),
          this.secrets,
        ),
      (bytes) => Redaction.markBytes(bytes, this.secrets),
    );
  }

  /**
   * Replace this world's state with a snapshot's. The world must register the
   * snapshot's components, run nothing, and have committed nothing and hold
   * nothing. Each job's world resolves by name among `worlds`. Bytes whose
   * digest does not match, and state the kernel could not have reached, refuse
   * before anything changes.
   */
  restoreSnapshot(
    bytes: Uint8Array,
    options: {
      readonly worlds?: ReadonlyArray<Invocation.World>;
      readonly secrets?: Redaction.Secrets;
    } = {},
  ): Promise<void> {
    return this.load().then(() =>
      this.restore(
        bytes,
        options.worlds ?? [],
        options.secrets ?? new Redaction.Secrets(),
      ),
    );
  }

  private restore(
    bytes: Uint8Array,
    worlds: ReadonlyArray<Invocation.World>,
    secrets: Redaction.Secrets,
  ) {
    this.refuseBusy(this.state.version, "restore");
    const decoded = Snapshot.decode(bytes, (json) =>
      Redaction.unmark(json, secrets),
    );
    if (Result.isFailure(decoded)) throw decoded.failure;
    const image = decoded.success;
    const checked = Snapshot.check(image, Scheduling.table);
    if (Result.isFailure(checked)) throw checked.failure;
    const registered = [...this.components.keys()].sort();
    const snapshot = [...image.components].sort();
    if (Arr.join(registered, "\u0000") !== Arr.join(snapshot, "\u0000")) {
      throw KernelRefusal.SnapshotComponentMismatch.make({
        snapshot,
        registered,
        message: `The snapshot holds components ${pipe(
          snapshot,
          Arr.map((p) => `"${p}"`),
          Arr.join(", "),
        )}, but this test backend registers ${pipe(
          registered,
          Arr.map((p) => `"${p}"`),
          Arr.join(", "),
        )}. Register the same components before restoring.`,
      });
    }
    for (const [id, { functionPath }] of image.jobs) {
      if (!this.exports(functionPath)) {
        throw KernelRefusal.SnapshotJobInconsistent.make({
          id,
          reason: "function",
          message: `The snapshot's job ${id} targets ${functionPath.udfPath} in "${functionPath.componentPath}", which that component does not export.`,
        });
      }
    }
    const byName = new Map<string, Invocation.World>();
    for (const world of this.own === undefined
      ? worlds
      : [...Arr.filter(worlds, (w) => w.name !== this.own!.name), this.own]) {
      if ((byName.get(world.name) ?? world) !== world) {
        throw unresolvedWorld(world.name, "ambiguous");
      }
      byName.set(world.name, world);
    }
    const targets = Array.from(
      image.jobs,
      ([id, { functionPath, standing, world }]): [
        DocumentId,
        Scheduling.Target,
      ] => {
        const resolved = world === null ? undefined : byName.get(world);
        if (world !== null && resolved === undefined) {
          throw unresolvedWorld(world, "missing");
        }
        return [id, { functionPath, standing, world: resolved }];
      },
    );
    const cronJobs = this.restoredCrons(image.crons, byName);
    this.state = image.state;
    this.floor = image.floor;
    this.nextDocId = image.identity.nextDocumentId;
    this.lastCreationTime = image.identity.lastCreationTime;
    this.nextAttemptId = image.identity.nextAttemptId;
    this.identityEpoch = image.identity.identityEpoch;
    this.nextFile = image.identity.nextFile;
    this.nextUploadToken = image.identity.nextUploadToken;
    this.files.clear();
    this.legacyIds.clear();
    for (const [id, file] of image.files) {
      this.files.set(id, file);
      this.legacyIds.set(file.uuid, id);
    }
    this.targets.clear();
    for (const [id, target] of targets) this.targets.set(id, target);
    this.cronJobs.clear();
    for (const [key, cron] of cronJobs) this.cronJobs.set(key, cron);
    this.cronsScheduled = true;
    this.secrets = secrets.copy();
    // The snapshot's key, put back from the secrets, never a fresh draw.
    // `Snapshot.decode` checked that it is a seed.
    this.deploymentKey.install(
      image.signingKey === null
        ? undefined
        : (image.signingKey as Identity.Seed),
    );
  }

  /**
   * The snapshot's cron jobs as this world runs them, refusing unless the app
   * declares exactly the snapshot's jobs, each with the same function,
   * arguments and schedule. Each job keeps the snapshot's next run and latest
   * outcome, and its world resolves by name. Nothing is redeclared and nothing
   * is drawn.
   */
  private restoredCrons(
    images: ReadonlyArray<Snapshot.CronImage>,
    byName: ReadonlyMap<string, Invocation.World>,
  ): Map<string, CronJob> {
    const declared = new Map(
      Arr.map(this.declared, (declaration) => [
        cronKey(declaration.componentPath, declaration.spec.name),
        declaration,
      ]),
    );
    const mismatch = (
      componentPath: string,
      name: string,
      reason: KernelRefusal.SnapshotCronMismatch["reason"],
      detail: string,
    ) =>
      KernelRefusal.SnapshotCronMismatch.make({
        componentPath,
        cronName: name,
        reason,
        message: `The snapshot's cron job "${name}" of component "${componentPath}" ${detail}. Restore into an app that declares the same cron jobs.`,
      });
    const restored = new Map<string, CronJob>();
    for (const image of images) {
      const key = cronKey(image.componentPath, image.name);
      const declaration = declared.get(key);
      if (declaration === undefined) {
        throw mismatch(
          image.componentPath,
          image.name,
          "undeclared",
          "is not declared by this app",
        );
      }
      const job: CronJob = {
        ...declaration,
        nextRun: 0,
        last: undefined,
        world: undefined,
      };
      const ours = declarationJson(job, (json) => json);
      if (
        Json.stringify(ours) !==
        Json.stringify({
          name: image.name,
          udfPath: image.udfPath,
          args: image.args,
          schedule: image.schedule,
        })
      ) {
        throw mismatch(
          image.componentPath,
          image.name,
          "changed",
          "is declared here with another function, arguments or schedule",
        );
      }
      const world = image.world === null ? undefined : byName.get(image.world);
      if (image.world !== null && world === undefined) {
        throw unresolvedWorld(image.world, "missing");
      }
      if (
        declaration.spec.schedule.kind !== "interval" &&
        world === undefined
      ) {
        throw KernelRefusal.CronRandomUnavailable.make({
          componentPath: image.componentPath,
          cronName: image.name,
          message: `The snapshot's cron job "${image.name}" runs on a ${declaration.spec.schedule.kind} schedule but names no test world to draw its delays from.`,
        });
      }
      restored.set(key, {
        ...job,
        nextRun: image.nextRun,
        // Decoding put back any marked secret, so a failure's text is raw again.
        last:
          image.last === null
            ? undefined
            : image.last.kind === "failed"
              ? { kind: "failed", error: image.last.error as string }
              : image.last,
        world,
      });
    }
    for (const [key, { componentPath, spec }] of declared) {
      if (!restored.has(key)) {
        throw mismatch(
          componentPath,
          spec.name,
          "missing",
          "is declared by this app but not held by the snapshot",
        );
      }
    }
    return restored;
  }

  /**
   * Whether `functionPath`'s component exports a Convex function there.
   */
  private exports({ componentPath, udfPath }: FunctionPath): boolean {
    const [modulePath, exportName = "default"] = pipe(udfPath, Str.split(":"));
    const func = this.components.get(componentPath)?.loaded.get(modulePath!)?.[
      exportName
    ];
    return (
      func?.isQuery === true ||
      func?.isMutation === true ||
      func?.isAction === true
    );
  }

  /**
   * Refuse a snapshot while any live registry `operation` waits on is
   * non-empty, or, restoring, once `version` shows the world committed
   * something of its own.
   */
  private refuseBusy(version: Kernel.Version, operation: "export" | "restore") {
    const counts = this.liveCounts();
    const refusals: {
      readonly [K in keyof typeof counts]: (count: number) => Error;
    } = {
      running: (count) => running("running", count, "calls from the test"),
      walks: (count) => running("walks", count, "scheduler walks"),
      functions: (count) =>
        running(
          "functions",
          count,
          "functions, nested and detached ones included",
        ),
      held: () => {
        const held = [...this.holding.keys()];
        return KernelRefusal.SnapshotWorldBusy.make({
          version,
          held,
          message: `The test backend holds attempts ${Arr.join(held, ", ")}, which a snapshot does not carry. Apply them first.`,
        });
      },
      sockets: (count) =>
        KernelRefusal.SnapshotSocketsOpen.make({
          sockets: count,
          message: `The test backend has ${count} open sync sockets, whose clients hold versions and query values a restore would rewind. Close every client first.`,
        }),
      subscribers: (count) =>
        KernelRefusal.SnapshotSubscribed.make({
          subscribers: count,
          message: `The test backend has ${count} subscribers, whose identity versions a restore would rewind. Restore into a test backend no client has subscribed to.`,
        }),
    };
    for (const key of Rec.keys(refusals) as Array<keyof typeof counts>) {
      const { blocks } = Snapshot.contract.live[key];
      if (operation === "export" && blocks === "restore") continue;
      if (counts[key] > 0) throw refusals[key](counts[key]);
    }
    if (operation === "restore" && version !== 0) {
      throw KernelRefusal.SnapshotWorldBusy.make({
        version,
        held: [],
        message: `The test backend has committed ${version} versions of its own. Restore a snapshot into a fresh test backend.`,
      });
    }
  }

  // Scheduled functions, on the kernel's clock.

  /**
   * The committed pending jobs, earliest deadline first.
   */
  jobs(): ReadonlyArray<Scheduling.Job> {
    return Arr.map(
      Scheduling.pending(this.state, this.targets),
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
   * The declared cron jobs, earliest next run first.
   */
  crons(): ReadonlyArray<Cron> {
    return Arr.map(
      this.cronsByNextRun(),
      ({ componentPath, spec, nextRun, last }) => ({
        componentPath,
        name: spec.name,
        udfPath: spec.udfPath,
        nextRun,
        last: last === undefined ? undefined : this.reportedOutcome(last),
      }),
    );
  }

  /**
   * A cron run's outcome as an artifact shows it: a failure's text through the
   * failure redaction, every kept secret marked. The raw text stays in the
   * job's replay state.
   */
  private reportedOutcome(last: CronOutcome): CronOutcome {
    return last.kind === "failed"
      ? {
          kind: "failed",
          error: Redaction.failure(last.error, this.secrets) as string,
        }
      : last;
  }

  /**
   * Move the clock forward `ms`, running every job and cron run whose time
   * falls on the way, in time order, each starting at its time. Jobs those
   * schedule inside the window run too. `advance(0)` runs what is due now and
   * crosses no future deadline. A cron run never counts against the budget:
   * each one moves its job's next run later.
   */
  advance(ms: number, budget = defaultBudget): Promise<void> {
    return this.track("walks", () =>
      this.openIn(this.own).then(() => {
        const until = this.now() + ms;
        return this.walk(
          (pending) => Arr.filter(pending, (job) => job.scheduledTime <= until),
          budget,
          until,
        ).then(() => this.raiseFloor(until));
      }),
    );
  }

  /**
   * Run jobs, earliest deadline first and each at its deadline, until only
   * standing jobs are pending. Every job run counts against `budget`.
   */
  drain(budget = defaultBudget): Promise<void> {
    return this.track("walks", () =>
      this.openIn(this.own).then(() =>
        this.walk(
          (pending) => Arr.filter(pending, (job) => !job.standing),
          budget,
        ),
      ),
    );
  }

  /**
   * Run the first of `select(pending)`, and with `cronsUntil` each cron run due
   * by then, until none is left, earliest first and moving the clock to each
   * one's time as it starts. The binary runs jobs and cron runs on separate
   * executors, so at one instant it orders neither before the other. The kernel
   * runs jobs first.
   */
  private walk(
    select: (pending: Array<Scheduling.Due>) => Array<Scheduling.Due>,
    budget: number,
    cronsUntil?: number,
  ): Promise<void> {
    const step = (ran: number): Promise<void> => {
      const left = select(Scheduling.pending(this.state, this.targets));
      const next = left[0];
      const cron =
        cronsUntil === undefined
          ? undefined
          : Option.getOrUndefined(
              Arr.findFirst(
                this.cronsByNextRun(),
                ({ nextRun }) => nextRun <= cronsUntil,
              ),
            );
      if (
        cron !== undefined &&
        (next === undefined || cron.nextRun < next.scheduledTime)
      ) {
        this.raiseFloor(cron.nextRun);
        return this.runCron(cron).then(() => step(ran));
      }
      if (next === undefined) return Promise.resolve();
      if (ran === budget) {
        const pending = Scheduling.functions(left);
        return Promise.reject(
          KernelRefusal.DrainBudgetExceeded.make({
            budget,
            pending,
            message: `Scheduled functions ran ${budget} jobs and work remains: ${pipe(
              pending,
              Arr.map(({ componentPath, name }) =>
                componentPath === ROOT ? name : `${name} in "${componentPath}"`,
              ),
              Arr.join(", "),
            )}. A function that schedules its own next run never lets the drain end, so its kit declares it with registerComponent's \`standing\` option.`,
          }),
        );
      }
      this.raiseFloor(next.scheduledTime);
      return this.runJob(next).then(() => step(ran + 1));
    };
    return step(0);
  }

  /**
   * Run one cron run as its own request, then schedule the next. The request is
   * a system one: no identity, no IP or user agent, a fresh request ID and no
   * scheduled function ID (`crates/application/src/cron_jobs/mod.rs:441-446`,
   * `crates/common/src/types/functions.rs:236-242`). A mutation's writes, jobs
   * it schedules included, publish only if it commits. Its next run comes from
   * the time it finished, whether it succeeded or failed
   * (`crates/application/src/cron_jobs/mod.rs:475-619`).
   */
  private runCron(cron: CronJob): Promise<void> {
    const request = newRequest(anonymous);
    const from: From = { caller: anonymous, request };
    const target: FunctionPath = {
      componentPath: cron.componentPath,
      udfPath: cron.spec.udfPath,
    };
    const run = () =>
      Promise.resolve().then(() =>
        this.resolve(target, "any").func.isMutation === true
          ? this.mutationAt(target, cron.spec.args, from)
          : this.actionAt(target, cron.spec.args, from),
      );
    return (
      cron.world === undefined
        ? Invocation.unbound(run)
        : Invocation.bind(
            Invocation.fresh(cron.world, cron.componentPath, request),
            run,
          )
    )
      .then(
        (): CronOutcome => ({ kind: "success" }),
        (error: unknown): CronOutcome => ({
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((last) => this.scheduleNextRun(cron, last));
  }

  /**
   * Record how a cron run ended and schedule the job's next run from the time
   * the run finished.
   */
  private scheduleNextRun(cron: CronJob, last: CronOutcome) {
    const next = this.searched(
      cron,
      Result.map(
        Crons.following(cron.spec.schedule, cron.nextRun, this.now(), (bound) =>
          this.draw(cron, bound),
        ),
        ({ next: at }) => at,
      ),
    );
    this.cronJobs.set(cronKey(cron.componentPath, cron.spec.name), {
      ...cron,
      nextRun: next,
      last,
    });
  }

  /**
   * The cron jobs, earliest next run first, then by component and name.
   */
  private cronsByNextRun(): Array<CronJob> {
    return Array.from(this.cronJobs.values()).sort(
      (a, b) =>
        a.nextRun - b.nextRun ||
        compare(a.componentPath, b.componentPath) ||
        compare(a.spec.name, b.spec.name),
    );
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
        return func.isQuery === true
          ? this.queryAt(job.target, job.args, from)
          : func.isMutation === true
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
      throw KernelRefusal.CommitTsNotIncreasing.make({
        version: this.state.version + 1,
        previous: this.state.commitTs,
        commitTs,
        message: `The runtime answered commit timestamp ${commitTs} for version ${this.state.version + 1}, which is not greater than the previous commit's ${this.state.commitTs}.`,
      });
    }
    this.state = Kernel.apply(this.state, writes, commitTs);
    for (const watcher of this.watchers) watcher();
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
    this.keepArgs(target, jobArgs);
    if (hasPendingValues(jobArgs)) {
      throw new Error(
        `Invalid arguments for "${target.udfPath}": a scheduled function cannot take an unresolved placeholder value.`,
      );
    }
    refuse(attempt.meter.schedule(jobArgs, execution.limits));
    const jobsIndex = indexKey(
      execution.componentPath,
      Scheduling.table,
      "by_id",
    );
    // A scheduled function that schedules reads its own job first
    // (`SchedulerModel::schedule`, `crates/model/src/scheduled_jobs/mod.rs:238-300`).
    const parentJob = execution.request.scheduledFunctionId;
    if (parentJob !== null) {
      refuse(
        attempt.meter.readInterval(
          jobsIndex,
          Metering.point([parentJob]),
          execution.limits,
        ),
      );
    }
    const id = this.generateId(Scheduling.table);
    attempt.meter.deriveInterval(jobsIndex, Metering.point([id]));
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
  private cancelJob(attempt: KernelAttempt, execution: Execution, id: any) {
    const { componentPath } = execution;
    validateId(Scheduling.table, id);
    const doc = this.readById(attempt, execution, id);
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
    this.keepArgs(functionPath, args);
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
    this.keepArgs(functionPath, args);
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
    this.keepArgs(functionPath, args);
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
    runtime: IoBans.Runtime = "isolate",
  ): Execution {
    const { identity, unverified } = callIdentity(
      from,
      functionPath.componentPath,
    );
    // A nested call runs under its caller's limits, which its budget can only
    // tighten, and gives them back when it ends (`run_udf`,
    // `crates/isolate/src/environment/udf/async_syscall.rs:700-706`, and
    // `commit_subtransaction`, `crates/database/src/transaction.rs:431-441`).
    const inherited =
      attempt === undefined || from.parent?.attempt === undefined
        ? Metering.defaults
        : from.parent.limits;
    const limits =
      attempt === undefined || from.budget === undefined
        ? inherited
        : Metering.fromBudget(from.budget, attempt.meter.used(), inherited);
    return {
      world: this,
      componentPath: functionPath.componentPath,
      udfPath: functionPath.udfPath,
      udfType,
      runtime,
      attempt,
      identity,
      unverified,
      request: from.request,
      startTime:
        startTime ??
        (from.parent !== undefined && from.parent.udfType !== "action"
          ? from.parent.startTime
          : this.now()),
      pagination,
      turn: new Turn(),
      limits,
      refused: from.parent?.refused ?? {},
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
    return this.track("functions", () => {
      const parentAttempt = from.parent?.attempt;
      const isNested = parentAttempt !== undefined;
      const attempt =
        top?.attempt ??
        (parentAttempt === undefined
          ? new KernelAttempt(this.state)
          : snapshotOnly
            ? parentAttempt.staleSnapshot()
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
      return unlessReplaced(
        execution,
        unlessEnded(
          execution,
          enter(execution, () =>
            q.invokeQuery(Json.stringify(convexToJson([parseArgs(args)]))),
          ).then((raw) => settled(execution, raw)),
        ),
      )
        .then((raw) => {
          const result = jsonToConvex(Json.parse(raw));
          if (!isNested && hasPendingValues(result)) {
            throw new Error(
              `Function ${functionPath.udfPath} return value invalid: queries ` +
                `cannot return an unresolved placeholder value.`,
            );
          }
          this.keepReturns(functionPath, result);
          validateReturnValue(resolved.returns, result, "query", functionPath);
          return result;
        })
        .catch((error: unknown) => {
          throw receiveConvexErrorData(error, convexErrorDataFor(from));
        });
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
    return unlessReplaced(
      execution,
      unlessEnded(
        execution,
        enter(execution, () =>
          m.invokeMutation(Json.stringify(convexToJson([parseArgs(args)]))),
        ).then((raw) => settled(execution, raw)),
      ),
    ).then((raw) => {
      const result = jsonToConvex(Json.parse(raw));
      const functionPath = {
        componentPath: execution.componentPath,
        udfPath: execution.udfPath,
      };
      this.keepReturns(functionPath, result);
      validateReturnValue(resolved.returns, result, "mutation", functionPath);
      return result;
    });
  }

  private runMutation(
    functionPath: FunctionPath,
    resolved: Pick<Resolved, "handler" | "args" | "returns">,
    args: any,
    from: From,
  ): Promise<any> {
    return this.track("functions", () => {
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
            throw receiveConvexErrorData(error, convexErrorDataFor(from));
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
    });
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
    return this.track("functions", () => {
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
            attempt
              .drained()
              .then((): Outcome => ({ _tag: "returned", value })),
          (error: unknown): Outcome => ({
            _tag: "failed",
            error: receiveConvexErrorData(error, convexErrorDataFor(from)),
          }),
        )
        .then((outcome) => {
          attempt.close();
          const held: Held = {
            view: {
              id: `attempt-${this.nextAttemptId++}`,
              functionPath,
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
          error: KernelRefusal.OptimisticConcurrencyControlFailure.make({
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
    resolved: Pick<Resolved, "handler" | "args" | "returns"> &
      Partial<Pick<Resolved, "runtime">>,
    args: any,
    from: From,
  ): Promise<any> {
    return this.track("functions", () => {
      const execution = this.execution(
        functionPath,
        "action",
        undefined,
        from,
        undefined,
        undefined,
        resolved.runtime ?? "isolate",
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
        unlessReplaced(
          execution,
          enter(execution, () =>
            a.invokeAction(
              from.request.requestId,
              Json.stringify(convexToJson([parseArgs(args)])),
            ),
          ),
        );
      // An action another function calls is an invocation of its own, with its
      // world's services, a start time read from its world's clock and its
      // world's random stream, as a scheduled job is.
      const bound =
        from.parent === undefined ? undefined : Invocation.current();
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
          const result = jsonToConvex(Json.parse(raw));
          this.keepReturns(functionPath, result);
          validateReturnValue(resolved.returns, result, "action", functionPath);
          return result;
        })
        .catch((error: unknown) => {
          throw receiveConvexErrorData(error, convexErrorDataFor(from));
        });
    });
  }

  // Secrets.

  private keepArgs(functionPath: FunctionPath, args: unknown) {
    Redaction.keep(
      args ?? {},
      placed(this.redaction.args(functionPath)),
      this.secrets,
    );
  }

  private keepReturns(functionPath: FunctionPath, result: Value) {
    Redaction.keep(
      result,
      placed(this.redaction.returns(functionPath)),
      this.secrets,
    );
  }

  private keepRow(componentPath: string, table: string, value: unknown) {
    Redaction.keep(
      value,
      placed(this.redaction.table(componentPath, table)),
      this.secrets,
    );
  }

  /**
   * Where a stored document holds secrets: its table's shape at its root, and
   * for a job's row, its target's argument shape at `args.0`.
   */
  private documentPlacements(
    componentPath: string,
    table: string,
    doc: { readonly _id: unknown; readonly name?: unknown },
  ): ReadonlyArray<Redaction.Placement> {
    const own = placed(this.redaction.table(componentPath, table));
    if (table !== Scheduling.table) return own;
    const target = this.targets.get(doc._id as DocumentId)?.functionPath ?? {
      componentPath,
      udfPath: String(doc.name),
    };
    return own.concat(placed(this.redaction.args(target), ["args", "0"]));
  }

  /**
   * A copy of the raw secrets this world has kept, for a restore of its
   * snapshots. It lives in memory only.
   */
  keptSecrets(): Redaction.Secrets {
    return this.secrets.copy();
  }

  /**
   * The failure report for `thrown`, whatever was thrown, with every kept
   * secret marked. `thrown` itself is never changed.
   */
  redactFailure(thrown: unknown): unknown {
    return Redaction.failure(thrown, this.secrets);
  }

  /**
   * `outcome` as an artifact writes it: a value marked by the shape of what
   * `functionPath` returns, a failure as its report.
   */
  redactOutcome(outcome: Outcome, functionPath?: FunctionPath): Outcome {
    return outcome._tag === "returned"
      ? {
          _tag: "returned",
          value: Redaction.markValue(
            outcome.value,
            placed(
              functionPath === undefined
                ? undefined
                : this.redaction.returns(functionPath),
            ),
            this.secrets,
          ),
        }
      : { _tag: "failed", error: this.redactFailure(outcome.error) };
  }

  /**
   * A changed document as an artifact writes it, marked by its table's shape.
   */
  redactChange(change: Kernel.Change): Kernel.Change {
    const document = (doc: StoredDocument | null) =>
      doc === null
        ? null
        : (Redaction.markValue(
            doc as Value,
            this.documentPlacements(
              change.componentPath,
              tableNameFromId(doc._id) ?? "",
              doc,
            ),
            this.secrets,
          ) as StoredDocument);
    return {
      ...change,
      before: document(change.before),
      after: document(change.after),
    };
  }

  /**
   * `json` as an artifact writes it: every string holding a kept secret
   * replaced by the marker text. For protocol messages and probe records, whose
   * values have no declared shape of their own.
   */
  redactJson(json: JSONValue): JSONValue {
    return Redaction.scrubJson(json, this.secrets);
  }

  /**
   * The function a subscription's or call's reference names, if it names one.
   */
  functionPathOf(reference: unknown): FunctionPath | undefined {
    try {
      return typeof reference === "function"
        ? undefined
        : pathOfReference(reference as FunctionReference<any>, ROOT);
    } catch {
      return undefined;
    }
  }

  /**
   * Read records as an artifact writes them. A key or range bound on a field
   * its table's shape holds secret is the marker, and so is any string holding
   * a kept secret.
   */
  projectReads(
    reads: ReadonlyArray<ReadSet.Read>,
  ): ReadonlyArray<ReadSet.Read> {
    return Arr.map(reads, (read) => {
      if (read.kind === "document") return read;
      const shape = this.redaction.table(read.componentPath, read.table);
      const sensitive = (fieldPath: string) =>
        shape !== undefined &&
        Redaction.sensitiveAt(shape, pipe(fieldPath, Str.split(".")));
      const value = (fieldPath: string, v: Value): Value =>
        sensitive(fieldPath)
          ? Redaction.marker
          : Redaction.markValue(v, [], this.secrets);
      const key = (k: ReadSet.Key | null) =>
        k === null
          ? null
          : Arr.map(k, (v, i) =>
              v === undefined ? undefined : value(read.fields[i] ?? "", v),
            );
      return {
        ...read,
        range: Arr.map(read.range, (bound) => ({
          ...bound,
          value: sensitive(bound.fieldPath)
            ? Redaction.marker
            : convexToJson(
                Redaction.markValue(
                  jsonToConvex(bound.value),
                  [],
                  this.secrets,
                ),
              ),
        })),
        after: key(read.after),
        through:
          read.through === "end" || read.through === null
            ? read.through
            : key(read.through),
      };
    });
  }

  /**
   * A held attempt as an artifact writes it: its read records projected and its
   * outcome marked.
   */
  projectHeld(view: HeldAttempt): HeldAttempt {
    return {
      ...view,
      reads: this.projectReads(view.reads),
      outcome: this.redactOutcome(view.outcome, view.functionPath),
    };
  }

  /**
   * What `apply` answered as an artifact writes it: an applied result marked by
   * the shape of what `functionPath` returns, a conflict's next attempt
   * projected, a refusal as its report.
   */
  projectApplied(
    applied: KernelApply,
    functionPath: FunctionPath | undefined,
  ): KernelApply {
    switch (applied.kind) {
      case "applied": {
        const outcome = this.redactOutcome(
          { _tag: "returned", value: applied.result },
          functionPath,
        );
        return outcome._tag === "returned"
          ? { ...applied, result: outcome.value }
          : applied;
      }
      case "conflict":
        return { ...applied, next: this.projectHeld(applied.next) };
      case "refused":
        return { ...applied, error: this.redactFailure(applied.error) };
      case "exhausted":
        return {
          ...applied,
          error: this.redactFailure(applied.error) as typeof applied.error,
        };
    }
  }

  /**
   * A function's arguments as an artifact writes them, marked by the shape of
   * its arguments. A command log of provider calls (#137's `commands()`) writes
   * each command's input through this.
   */
  projectArguments(functionPath: FunctionPath, args: Value): Value {
    return Redaction.markValue(
      args,
      placed(this.redaction.args(functionPath)),
      this.secrets,
    );
  }

  // Syscalls.

  private schema(componentPath: string) {
    return this.component(componentPath).schema;
  }

  private view(execution: Execution): KernelQuery.TableView {
    const attempt = transaction(execution);
    const { componentPath, limits } = execution;
    return {
      schema: this.schema(componentPath),
      scan: (tableName) => attempt.scan(componentPath, tableName),
      read: ({ index, ...interval }, after) => {
        const advance = attempt.readInterval({
          ...interval,
          componentPath,
          after,
        });
        return (through) => {
          advance(through);
          const examined = Metering.examined(
            interval.range,
            interval.order,
            after,
            through,
          );
          if (examined !== null) {
            refuse(
              attempt.meter.readInterval(
                indexKey(componentPath, interval.table, index),
                examined,
                limits,
              ),
            );
          }
        };
      },
      examine: (table, doc) =>
        refuse(attempt.meter.readDocument(doc, isSystemTable(table), limits)),
    };
  }

  /**
   * Read one document by ID, as the binary's `get_inner` does for a get and for
   * the document a patch, replace, delete or cancel changes: it reads the ID's
   * interval of the table's `by_id` index, then charges the document if there
   * is one (`crates/database/src/transaction.rs:1188-1250`).
   */
  private readById(
    attempt: KernelAttempt,
    execution: Execution,
    id: DocumentId,
  ): StoredDocument | null {
    const { componentPath, limits } = execution;
    const table = tableNameFromId(id)!;
    attempt.readDocument(componentPath, id);
    refuse(
      attempt.meter.readInterval(
        indexKey(componentPath, table, "by_id"),
        Metering.point([id]),
        limits,
      ),
    );
    const doc = attempt.get(componentPath, id);
    if (doc !== null) {
      refuse(attempt.meter.readDocument(doc, isSystemTable(table), limits));
    }
    return doc;
  }

  /**
   * Stage a write to a user table, counted against the execution's limits
   * first. A write over a limit is not staged (`Writes::update`,
   * `crates/database/src/writes.rs:241-310`).
   */
  private stage(
    execution: Execution,
    id: DocumentId,
    doc: StoredDocument | null,
  ) {
    const attempt = transaction(execution);
    refuse(attempt.meter.write(doc, execution.limits));
    attempt.write(execution.componentPath, id, doc);
  }

  private generateId(table: string): DocumentId {
    const counter = pipe(
      String(this.nextDocId++),
      Str.padStart(TYPICAL_CONVEX_ID_LENGTH - table.length, "0"),
    );
    return (counter + table) as DocumentId;
  }

  syscall(op: string, jsonArgs: string): string {
    const execution = current();
    try {
      return this.syncSyscall(op, jsonArgs, execution);
    } catch (error) {
      throw keepRefusal(error, execution);
    }
  }

  private syncSyscall(
    op: string,
    jsonArgs: string,
    execution: Execution,
  ): string {
    const args = Json.parse(jsonArgs);
    if (execution.attempt?.closed === true) throw closed(execution, op);
    switch (op) {
      case "1.0/getSnapshotTs":
        return Json.stringify(
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
        return Json.stringify({ queryId });
      }
      case "1.0/queryCleanup":
        this.queries.delete(args.queryId);
        return Json.stringify({});
      case "1.0/db/normalizeId": {
        const tableName = tableNameFromId(args.idString);
        return Json.stringify({
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
    return this.queueSyscall(op, jsonArgs, execution).catch(
      (error: unknown) => {
        throw keepRefusal(error, execution);
      },
    );
  }

  private queueSyscall(
    op: string,
    jsonArgs: string,
    execution: Execution,
  ): Promise<string> {
    const attempt = execution.attempt;
    if (attempt === undefined) {
      return Promise.resolve().then(() =>
        this.dispatchAsync(op, Json.parse(jsonArgs), execution),
      );
    }
    if (attempt.closed) return Promise.reject(closed(execution, op));
    // A syscall counts toward its frame's lifetime from the moment it is
    // queued, so a frame never closes with a write still waiting its turn.
    const end = attempt.begin();
    return execution.turn
      .take(() => this.dispatchAsync(op, Json.parse(jsonArgs), execution))
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
        return Json.stringify(convexToJson(this.get(execution, table, id)));
      }
      case "1.0/queryStreamNext": {
        const results = this.queries.get(args.queryId);
        if (results === undefined) throw new Error("Bad queryId");
        const { value, done } = results.next();
        return Json.stringify(
          convexToJson(
            done === true
              ? { value: null, done: true }
              : { value, done: false },
          ),
        );
      }
      case "1.0/queryPage": {
        const pagination = execution.pagination;
        if (pagination !== undefined) {
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
        if (pagination !== undefined) pagination.end = page.continueCursor;
        return Json.stringify(convexToJson(page as any));
      }
      case "1.0/insert":
        return Json.stringify({
          _id: this.insert(execution, args.table, jsonToConvex(args.value)),
        });
      case "1.0/shallowMerge":
        this.patch(execution, args.table, args.id, args.value);
        return Json.stringify({});
      case "1.0/replace":
        this.replace(execution, args.table, args.id, args.value);
        return Json.stringify({});
      case "1.0/remove":
        this.remove(execution, args.table, args.id);
        return Json.stringify({});
      case "1.0/count": {
        const attempt = transaction(execution);
        // The binary counts a table by reading its whole `by_id` index, and no
        // document (`count_tablet`, `crates/database/src/bootstrap_model/table.rs:133-160`).
        refuse(
          attempt.meter.readInterval(
            indexKey(execution.componentPath, args.table, "by_id"),
            Metering.everything,
            execution.limits,
          ),
        );
        attempt.readInterval({
          kind: "interval",
          componentPath: execution.componentPath,
          table: args.table,
          fields: ["_creationTime", "_id"],
          order: "asc",
          range: [],
          after: null,
        })("end");
        return Json.stringify(
          attempt.scan(execution.componentPath, args.table).length,
        );
      }
      case "1.0/getFunctionMetadata":
        return Json.stringify(
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
        return Json.stringify(convexToJson(execution.request as any));
      case "1.0/getDeploymentMetadata":
        return Json.stringify(
          convexToJson({ name: "test", region: null, class: "s16" }),
        );
      case "1.0/actions/query":
      case "1.0/actions/mutation":
      case "1.0/actions/action": {
        const from: From = {
          request: execution.request,
          parent: execution,
          syscall: true,
        };
        const functionPath = functionPathOf(args, execution.componentPath);
        const run =
          op === "1.0/actions/query"
            ? this.queryAt(functionPath, args.args, from)
            : op === "1.0/actions/mutation"
              ? this.mutationAt(functionPath, args.args, from)
              : this.actionAt(functionPath, args.args, from);
        return run.then((value) => Json.stringify(convexToJson(value)));
      }
      case "1.0/runUdf": {
        const { udfType, args: udfArgs, transactionLimits } = args;
        const from: From = {
          request: execution.request,
          parent: execution,
          budget: budgetOf(transactionLimits),
          syscall: true,
        };
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
        return run.then((result) => Json.stringify(convexToJson(result)));
      }
      case "1.0/createFunctionHandle": {
        const functionPath = functionPathOf(args, execution.componentPath);
        this.component(functionPath.componentPath);
        return Json.stringify(createFunctionHandle(functionPath));
      }
      case "1.0/auditLog":
        return Json.stringify(null);
      case "1.0/schedule":
        return Json.stringify(
          convexToJson(
            this.scheduleJob(transaction(execution), execution, args),
          ),
        );
      case "1.0/actions/schedule":
        return Json.stringify(
          convexToJson(
            this.commitNow((attempt) =>
              this.scheduleJob(attempt, execution, args),
            ),
          ),
        );
      case "1.0/cancel_job":
        this.cancelJob(transaction(execution), execution, args.id);
        return Json.stringify({});
      case "1.0/actions/cancel_job":
        this.commitNow((attempt) =>
          this.cancelJob(attempt, execution, args.id),
        );
        return Json.stringify({});
      case "1.0/storageGetUrl": {
        const found = this.findFile(
          execution,
          "storage.getUrl",
          args.storageId,
        );
        return Json.stringify(
          found === null ? null : Storage.fileUrl(found.file),
        );
      }
      case "1.0/storageGetMetadata": {
        const found = this.findFile(
          execution,
          "storage.getMetadata",
          args.storageId,
        );
        return Json.stringify(
          found === null ? null : Storage.metadata(found.doc, found.file),
        );
      }
      case "1.0/storageGet": {
        const found = this.findFile(execution, "storage.get", args.storageId);
        if (found !== null) {
          refuse(
            transaction(execution).meter.readFile(
              found.id,
              found.file.bytes.length,
              execution.limits,
            ),
          );
        }
        return Json.stringify(
          found === null
            ? null
            : {
                blob: Base64.fromByteArray(found.file.bytes),
                contentType: found.doc["contentType"],
              },
        );
      }
      case "1.0/storageGenerateUploadUrl":
        return Json.stringify(
          Storage.uploadUrl(`kernel-unsigned-${this.nextUploadToken++}`),
        );
      case "1.0/storageStore":
        return Json.stringify(
          this.storageWrite(execution, (attempt) =>
            this.storeFile(
              execution,
              attempt,
              Base64.toByteArray(args.blob),
              args.contentType,
              args.sha256,
            ),
          ),
        );
      case "1.0/storageDelete":
        this.storageWrite(execution, (attempt) =>
          this.deleteFile(execution, attempt, args.storageId),
        );
        return Json.stringify(null);
      case "1.0/getTransactionMetrics":
        // An action has no transaction, and the binary's action syscalls do
        // not know this one (`crates/isolate/src/environment/action/async_syscall.rs:105`).
        if (execution.attempt === undefined) {
          throw new Error(`Unknown async operation ${op}`);
        }
        return Json.stringify(
          execution.attempt.meter.metrics(execution.limits),
        );
      case "1.0/actions/vectorSearch":
        throw KernelRefusal.requiresBinary("vectorSearch");
      default:
        throw new Error(
          `The test kernel does not support async syscall: "${op}"`,
        );
    }
  }

  /**
   * An action's `storage.store` and `storage.get`. The binary streams the blob
   * through its upload and download paths (`storeBlob` and `getBlob` in
   * `npm-packages/udf-runtime/src/storage.ts`). The kernel holds the bytes in
   * memory and keeps the same rows and refusals.
   */
  jsSyscall(op: string, args: any): Promise<any> {
    return Promise.resolve().then((): unknown => {
      const execution = current();
      switch (op) {
        case "storage/storeBlob": {
          const { blob, options } = args as {
            blob: unknown;
            options?: { sha256?: string };
          };
          if (!(blob instanceof Blob)) {
            throw new Error(
              "store() expects a Blob. If you are trying to store a Request, `await request.blob()` will give you the correct input.",
            );
          }
          return blob
            .arrayBuffer()
            .then((buffer) =>
              this.storageWrite(execution, (attempt) =>
                this.storeFile(
                  execution,
                  attempt,
                  new Uint8Array(buffer),
                  blob.type,
                  options?.sha256,
                ),
              ),
            );
        }
        case "storage/getBlob": {
          const { storageId } = args as { storageId: unknown };
          if (typeof storageId !== "string") {
            throw new Error(
              `storage.get requires a string storageId but received ${String(storageId)}`,
            );
          }
          const found = this.findFile(execution, "storage.get", storageId);
          return found === null
            ? null
            : new Blob([found.file.bytes as Uint8Array<ArrayBuffer>], {
                type: (found.doc["contentType"] as string | null) ?? "",
              });
        }
        default:
          throw new Error(
            `The test kernel does not support js syscall: "${op}"`,
          );
      }
    });
  }

  // File storage. A file is a row in its component's `_storage` table, read
  // and written through the attempt like any document, and its bytes beside it.

  /**
   * Where a function reads storage: its attempt, or, from an action, the latest
   * commit, as the binary's action callbacks read it.
   */
  private reader(execution: Execution): KernelAttempt {
    return execution.attempt ?? new KernelAttempt(this.state);
  }

  /**
   * Write through the function's attempt, or, from an action, commit at once.
   */
  private storageWrite<A>(
    execution: Execution,
    write: (attempt: KernelAttempt) => A,
  ): A {
    return execution.attempt === undefined
      ? this.commitNow(write)
      : write(execution.attempt);
  }

  /**
   * The file a storage ID names in the function's component, read through
   * `attempt`, or `null` when it names none.
   */
  private findFile(
    execution: Execution,
    operation: string,
    storageId: unknown,
    attempt: KernelAttempt = this.reader(execution),
  ): {
    readonly id: DocumentId;
    readonly doc: StoredDocument;
    readonly file: Storage.File;
  } | null {
    const parsed = orThrow(Storage.parseId(operation, storageId));
    const id =
      parsed.kind === "document" ? parsed.id : this.legacyIds.get(parsed.uuid);
    if (id === undefined) return null;
    attempt.readDocument(execution.componentPath, id);
    const doc = attempt.get(execution.componentPath, id);
    const file = this.files.get(id);
    return doc === null || file === undefined ? null : { id, doc, file };
  }

  /**
   * Store `bytes` as a new file in the function's component. The content type
   * and the declared digest are checked before anything is written.
   */
  private storeFile(
    execution: Execution,
    attempt: KernelAttempt,
    bytes: Uint8Array,
    type: unknown,
    expectedSha256: unknown,
  ): DocumentId {
    const contentType = orThrow(
      Storage.contentType(
        execution.udfType === "action" ? "action" : "mutation",
        type,
      ),
    );
    orThrow(
      Storage.checkDigest(
        "storage.store",
        expectedSha256,
        Storage.digest(bytes),
      ),
    );
    // A query or mutation stores within its transaction's file limits. An
    // action's store is no transaction, and the binary counts it toward none.
    const metered = execution.attempt !== undefined;
    if (metered)
      refuse(attempt.meter.checkStore(bytes.length, execution.limits));
    const id = this.generateId(Storage.table);
    if (metered) attempt.meter.storeFile(id, bytes.length);
    const file: Storage.File = {
      componentPath: execution.componentPath,
      uuid: Storage.uuid(this.nextFile++),
      bytes,
    };
    this.files.set(id, file);
    this.legacyIds.set(file.uuid, id);
    attempt.write(
      execution.componentPath,
      id,
      Storage.row(
        id,
        this.creationTime(
          execution.udfType === "action" ? this.now() : execution.startTime,
        ),
        bytes,
        contentType,
      ),
    );
    return id;
  }

  /**
   * Delete a file's row. A storage ID that names no file is refused, as the
   * binary's `FileStorage::delete` refuses it.
   */
  private deleteFile(
    execution: Execution,
    attempt: KernelAttempt,
    storageId: unknown,
  ) {
    const found = this.findFile(
      execution,
      "storage.delete",
      storageId,
      attempt,
    );
    if (found === null) {
      throw Storage.StorageIdNotFound.make({
        storageId: String(storageId),
        message: `storage id ${String(storageId)} not found`,
      });
    }
    attempt.write(execution.componentPath, found.id, null);
    attempt.meter.deleteFile(found.id);
  }

  // Documents. The checks and messages are convex-test's.

  private get(execution: Execution, tableName: unknown, id: unknown) {
    validateId(tableName, id);
    return this.readById(transaction(execution), execution, id);
  }

  private insert(execution: Execution, table: string, value: any): DocumentId {
    const attempt = transaction(execution);
    this.keepRow(execution.componentPath, table, value);
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      table,
      value,
    );
    const _id = this.generateId(table);
    // A new ID joins the table's `by_id` reads without counting as one.
    attempt.meter.deriveInterval(
      indexKey(execution.componentPath, table, "by_id"),
      Metering.point([_id]),
    );
    this.stage(execution, _id, {
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
    const document = this.readById(transaction(execution), execution, id);
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
    for (const [key, v] of Rec.toEntries(value)) {
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
    this.keepRow(execution.componentPath, tableNameFromId(_id)!, merged);
    const next = { _id, _creationTime, ...merged } as StoredDocument;
    if (sameDocument(document, next)) return;
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      tableNameFromId(_id)!,
      merged,
    );
    this.stage(execution, _id, next);
  }

  private replace(
    execution: Execution,
    tableName: unknown,
    id: unknown,
    value: Record<string, any>,
  ) {
    const document = this.existing(execution, tableName, id, "replace", value);
    const fields = this.fields(document, value);
    this.keepRow(
      execution.componentPath,
      tableNameFromId(document._id)!,
      fields,
    );
    const next = {
      ...fields,
      _id: document._id,
      _creationTime: document._creationTime,
    } as StoredDocument;
    if (sameDocument(document, next)) return;
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      tableNameFromId(document._id)!,
      fields,
    );
    this.stage(execution, document._id, next);
  }

  private remove(execution: Execution, tableName: unknown, id: unknown) {
    const document = this.existing(
      execution,
      tableName,
      id,
      "delete",
      undefined,
    );
    this.stage(execution, document._id, null);
  }
}

/**
 * Where a call comes from. A call from the test carries its accessor's caller.
 * A nested call carries its parent execution and takes its identity from it.
 * `syscall` marks a nested call its parent made through `Convex.asyncSyscall`,
 * whose answer the parent's syscall wrapper decodes. An action's own
 * `ctx.runQuery`, `ctx.runMutation` and `ctx.runAction` call the kernel
 * directly instead.
 */
type From =
  | {
      readonly caller: Caller;
      readonly request: Request;
      readonly unverified?: KernelRefusal.InvalidToken | undefined;
      readonly parent?: undefined;
      readonly budget?: undefined;
      readonly syscall?: undefined;
    }
  | {
      readonly parent: Execution;
      readonly request: Request;
      readonly budget?: Metering.Budget | undefined;
      readonly syscall?: true;
    };

/**
 * The identity a call runs with, by the binary's rules (convex-backend
 * `cccbade4`).
 *
 * - A query's or mutation's nested call runs on its caller's transaction, and
 *   `getUserIdentity` reads that transaction's identity in a component as in
 *   the app (`crates/isolate/src/environment/udf/async_syscall.rs:629-724`,
 *   `:1111-1141`). So a component a query or a mutation calls sees the caller,
 *   at every depth.
 * - An action's call passes its identity through `propagate_component_auth`,
 *   which keeps it only from the app to the app
 *   (`crates/isolate/src/environment/action/async_syscall.rs:166`,
 *   `crates/model/src/components/auth.rs:6-19`).
 * - A client reaches only the app's functions. A test that calls a component
 *   directly gets no identity, as a component's HTTP action does
 *   (`crates/function_runner/src/server.rs:450-455`).
 *
 * A refused HTTP token is part of the identity, the binary's unknown identity
 * that holds the verifier's error, so `unverified` travels by the same rules.
 */
const callIdentity = (
  from: From,
  componentPath: string,
): Pick<Execution, "identity" | "unverified"> => {
  if (from.parent === undefined) {
    return componentPath === ROOT
      ? { identity: from.caller.identity, unverified: from.unverified }
      : none;
  }
  const { parent } = from;
  if (parent.udfType !== "action") return parent;
  return parent.componentPath === ROOT && componentPath === ROOT
    ? parent
    : none;
};

const none: Pick<Execution, "identity" | "unverified"> = {
  identity: null,
  unverified: undefined,
};

/**
 * How a `ConvexError`'s data leaves a call from `from`: as Convex JSON across a
 * syscall, whose wrapper decodes it once, and as a Convex value anywhere else.
 */
const convexErrorDataFor = (from: From): ConvexErrorDataEncoding =>
  from.syscall === true ? "json" : "value";

const refuse = (error: Metering.TransactionLimitExceeded | undefined) => {
  if (error !== undefined) throw error;
};

/**
 * One index of one table in one component, as the binary keys a read set.
 */
const indexKey = (componentPath: string, table: string, index: string) =>
  `${componentPath}\u0000${table}\u0000${index}`;

const isSystemTable = (table: string) => pipe(table, Str.startsWith("_"));

const isFieldMap = (value: unknown): value is object =>
  typeof value === "object" && value !== null && isSimpleObject(value);

/**
 * Whether two stored values are the same value, an unresolved commit timestamp
 * included. The binary compares pending values structurally, so a pending
 * timestamp equals only another pending timestamp, at any depth (`PendingValue`
 * derives `PartialEq`, `crates/value/src/pending.rs:56-75`, as
 * `PendingDocument` does, `crates/common/src/document.rs:624-632`). Concrete
 * values compare by `ConvexValue`'s total order
 * (`crates/value/src/sorting.rs:468-472`), which `compareValues` follows.
 * `compareValues` alone ranks a pending timestamp as the largest int64, so it
 * cannot tell the two apart. An object field set to `undefined` is absent.
 */
const sameValue = (a: unknown, b: unknown): boolean => {
  const aPending = a instanceof CommitTsPlaceholder;
  const bPending = b instanceof CommitTsPlaceholder;
  if (aPending || bPending) return aPending && bPending;
  if (Arr.isArray(a) || Arr.isArray(b)) {
    return (
      Arr.isArray(a) &&
      Arr.isArray(b) &&
      a.length === b.length &&
      Arr.every(a, (value, i) => sameValue(value, b[i]))
    );
  }
  if (isFieldMap(a) || isFieldMap(b)) {
    if (!isFieldMap(a) || !isFieldMap(b)) return false;
    const fields = (value: object) =>
      Arr.filter(Rec.toEntries(value), ([, field]) => field !== undefined);
    const aFields = fields(a);
    const bFields = new Map(fields(b));
    return (
      aFields.length === bFields.size &&
      Arr.every(
        aFields,
        ([key, field]) =>
          bFields.has(key) && sameValue(field, bFields.get(key)),
      )
    );
  }
  return compareValues(a as Value, b as Value) === 0;
};

/**
 * Whether a patch or replace leaves a document as it was. The binary then
 * writes nothing (`patch_inner` and `replace_inner`,
 * `crates/database/src/transaction.rs:713-790`).
 */
const sameDocument = (before: StoredDocument, after: StoredDocument) =>
  sameValue(before, after);

/**
 * A nested call's `transactionLimits`. The binary reads each field as an
 * unsigned integer and ignores fields it does not know (`TransactionLimits`,
 * `crates/database/src/execution_size.rs:62-95`).
 */
const budgetOf = (limits: unknown): Metering.Budget | undefined => {
  if (limits === undefined || limits === null) return undefined;
  const budget: Partial<Record<keyof Metering.Limits, number>> = {};
  for (const metric of Rec.keys(Metering.defaults) as Array<
    keyof Metering.Limits
  >) {
    const value = (limits as Record<string, unknown>)[metric];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `Invalid arguments for \`runUdf\`: transactionLimits.${metric} must be a non-negative integer, got ${Json.stringify(value)}`,
      );
    }
    budget[metric] = value;
  }
  return budget;
};

const closed = (execution: Execution, operation: string) =>
  KernelRefusal.ClosedAttempt.make({
    operation,
    message: `"${operation}" reached mutation ${execution.udfPath} after it returned and its syscalls settled. Await every read and write inside the handler.`,
  });

const orThrow = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

/**
 * Keep `error` as `execution`'s refusal if it is one, and hand it back.
 */
const keepRefusal = (error: unknown, execution: Execution): unknown => {
  if (KernelRefusal.isKernelRefusal(error)) execution.refused.first ??= error;
  return error;
};

/**
 * The kernel refusal behind a function's failure, if any: the thrown value
 * itself, or the first refusal one of its syscalls threw.
 */
const refusalOf = (thrown: unknown, execution: Execution): unknown =>
  KernelRefusal.isKernelRefusal(thrown) ? thrown : execution.refused.first;

/**
 * `thrown` as the running kernel function's world reports a failure: a copy
 * with every kept secret marked. Outside a kernel function, as on convex-test,
 * `thrown` itself.
 */
export const redactCurrentFailure = (thrown: unknown): unknown =>
  executions.getStore()?.world.redactFailure(thrown) ?? thrown;

/**
 * The kernel refusal behind a failure inside the running kernel function, if
 * any. Outside one, as on convex-test, only a refusal thrown as itself.
 */
export const currentRefusal = (thrown: unknown): unknown => {
  const execution = executions.getStore();
  if (execution !== undefined) return refusalOf(thrown, execution);
  return KernelRefusal.isKernelRefusal(thrown) ? thrown : undefined;
};

const transaction = (execution: Execution): KernelAttempt => {
  if (execution.attempt === undefined) {
    throw new Error(
      "The database is only available in queries and mutations. An action reads and writes through `ctx.runQuery` and `ctx.runMutation`.",
    );
  }
  return execution.attempt;
};

/**
 * `ctx.auth` as each kind of function reads it. Under a refused token, an
 * action, the HTTP action itself or one it ran, throws the verifier's error
 * (`isolate/src/environment/action/task_executor.rs:205-216`). It reaches the
 * handler as a plain `Error` whose message is the error's own
 * (`isolate/src/environment/helpers/promise.rs:74-76`,
 * `errors/src/lib.rs:25-26`, `:989-994`), rethrown by `performAsyncSyscall`
 * without `data` (`convex/src/server/impl/syscall.ts:47-52`). A query or a
 * mutation reads its transaction's identity, and an unknown identity is none
 * (`isolate/src/environment/udf/async_syscall.rs:1111-1142`,
 * `database/src/transaction.rs:390-396`).
 */
const queryAuth = (execution: Execution) => ({
  getUserIdentity: () => {
    if (execution.udfType === "action" && execution.unverified !== undefined) {
      return Promise.reject(new Error(execution.unverified.message));
    }
    execution.attempt?.observeIdentity();
    return Promise.resolve(execution.identity);
  },
});

const mutationAuth = (execution: Execution) => ({
  ...queryAuth(execution),
  signJwt: (options: unknown) =>
    execution.world.deploymentKey.sign(
      execution.componentPath,
      options,
      execution.startTime,
    ),
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
