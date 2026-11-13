import * as Schema from "effect/Schema";

/**
 * The kernel never answers this operation in process. Only the binary does.
 */
export class RequiresBinary extends Schema.TaggedError<RequiresBinary>()(
  "RequiresBinary",
  {
    operation: Schema.Literals(["textSearch", "vectorSearch"]),
    message: Schema.String,
  },
) {}

/**
 * A later kernel row supplies this operation. Until then the kernel refuses it
 * rather than answer with convex-test's behaviour.
 */
export class KernelRowPending extends Schema.TaggedError<KernelRowPending>()(
  "KernelRowPending",
  {
    operation: Schema.String,
    row: Schema.Int,
    message: Schema.String,
  },
) {}

/**
 * A component was registered after the test backend opened, so its modules
 * would load after a function had already run.
 */
export class RegisteredAfterOpen extends Schema.TaggedError<RegisteredAfterOpen>()(
  "RegisteredAfterOpen",
  { componentPath: Schema.String, message: Schema.String },
) {}

/**
 * Every attempt of a mutation read data a commit changed before it could
 * publish. The kernel gives up on attempt 5.
 */
export class OptimisticConcurrencyControlFailure extends Schema.TaggedError<OptimisticConcurrencyControlFailure>()(
  "OptimisticConcurrencyControlFailure",
  { attempts: Schema.Int, message: Schema.String },
) {}

/**
 * A syscall reached a mutation's attempt after the mutation returned and its
 * syscalls drained, so the attempt was already held or published.
 */
export class ClosedAttempt extends Schema.TaggedError<ClosedAttempt>()(
  "ClosedAttempt",
  { operation: Schema.String, message: Schema.String },
) {}

/**
 * `apply` named an attempt the kernel does not hold: it was already applied, or
 * never prepared.
 */
export class StaleAttempt extends Schema.TaggedError<StaleAttempt>()(
  "StaleAttempt",
  { id: Schema.String, message: Schema.String },
) {}

/**
 * The runtime answered a commit timestamp no greater than the previous
 * commit's.
 */
export class CommitTsNotIncreasing extends Schema.TaggedError<CommitTsNotIncreasing>()(
  "CommitTsNotIncreasing",
  {
    version: Schema.Int,
    previous: Schema.BigInt,
    commitTs: Schema.BigInt,
    message: Schema.String,
  },
) {}

/**
 * Draining scheduled functions ran its budget of jobs and work still remained.
 * A self-rescheduling function keeps the drain from ending unless its kit
 * declares it standing.
 */
export class DrainBudgetExceeded extends Schema.TaggedError<DrainBudgetExceeded>()(
  "DrainBudgetExceeded",
  {
    budget: Schema.Int,
    pending: Schema.Array(
      Schema.Struct({ componentPath: Schema.String, name: Schema.String }),
    ),
    message: Schema.String,
  },
) {}

/**
 * A component declared a standing source its modules do not export.
 */
export class UnknownStandingSource extends Schema.TaggedError<UnknownStandingSource>()(
  "UnknownStandingSource",
  { componentPath: Schema.String, name: Schema.String, message: Schema.String },
) {}

/**
 * A function would have run, or ran, with a host global the kernel refuses
 * unguarded. `notConfigurable`: a test replaced it with a property the kernel
 * cannot redefine, so the function did not start. `replacedWhileRunning`: its
 * descriptor was replaced while the function ran, so a call made through the
 * replacement reached it unchecked. The function fails at settlement, a
 * mutation publishes none of its writes, and the guard is installed again.
 */
export class UnguardableGlobal extends Schema.TaggedError<UnguardableGlobal>()(
  "UnguardableGlobal",
  {
    reason: Schema.Literals(["notConfigurable", "replacedWhileRunning"]),
    names: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

const globals = (names: ReadonlyArray<string>) =>
  names.map((name) => `globalThis.${name}`).join(", ");

export const unguardableGlobal = (names: ReadonlyArray<string>) =>
  new UnguardableGlobal({
    reason: "notConfigurable",
    names,
    message: `The test kernel cannot guard ${globals(names)}: a test replaced it with a property that cannot be redefined, so a function could reach the host's implementation unchecked. Replace it with a configurable property, as vi.stubGlobal does, or assign it.`,
  });

export const replacedWhileRunning = (
  udfPath: string,
  names: ReadonlyArray<string>,
) =>
  new UnguardableGlobal({
    reason: "replacedWhileRunning",
    names,
    message: `${globals(names)} was redefined while ${udfPath} ran, so a call made through the replacement reached it without the test kernel's check. The function fails, a mutation's writes are rolled back, and the guard is installed again. Replace a global between functions, or assign it, which keeps it guarded.`,
  });

/**
 * The kernel could not tell, or refuses, the runtime a module runs in: a module
 * with no source when the test gave sources, a `"use node"` directive where the
 * bundler forbids one, or a Confect Node action in a module without the
 * directive.
 */
export class ModuleRuntime extends Schema.TaggedError<ModuleRuntime>()(
  "ModuleRuntime",
  {
    reason: Schema.Literals([
      "missingSource",
      "nodeNotAllowed",
      "markerDisagrees",
    ]),
    componentPath: Schema.String,
    module: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * A module exports an action whose runtime the kernel cannot tell: the test
 * gave the component no sources to read its `"use node"` directive from, and
 * the action carries no Confect mark, so it is a plain Convex action that
 * Convex could run in Node or in its isolate. Refused when the kernel opens,
 * before any function runs.
 */
export class ActionRuntimeUnknown extends Schema.TaggedError<ActionRuntimeUnknown>()(
  "ActionRuntimeUnknown",
  {
    componentPath: Schema.String,
    module: Schema.String,
    exports: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export const requiresBinary = (operation: RequiresBinary["operation"]) =>
  new RequiresBinary({
    operation,
    message: `The test kernel does not simulate ${operation}. Run this case against the Convex binary.`,
  });

export const rowPending = (operation: string, row: number) =>
  new KernelRowPending({
    operation,
    row,
    message: `The test kernel supplies ${operation} in build-order row ${row}.`,
  });

/**
 * Snapshot bytes are not a kernel snapshot this kernel reads: an unknown
 * header, a body that is not the snapshot's JSON, or a value that does not
 * decode.
 */
export class SnapshotMalformed extends Schema.TaggedError<SnapshotMalformed>()(
  "SnapshotMalformed",
  { reason: Schema.String, message: Schema.String },
) {}

/**
 * A snapshot's body does not hash to the digest its header names, so its bytes
 * changed after export.
 */
export class SnapshotDigestMismatch extends Schema.TaggedError<SnapshotDigestMismatch>()(
  "SnapshotDigestMismatch",
  { expected: Schema.String, actual: Schema.String, message: Schema.String },
) {}

/**
 * A snapshot's components are not the components registered on the world
 * restoring it.
 */
export class SnapshotComponentMismatch extends Schema.TaggedError<SnapshotComponentMismatch>()(
  "SnapshotComponentMismatch",
  {
    snapshot: Schema.Array(Schema.String),
    registered: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/**
 * A job's test world is named by no world, or by more than one, so the job
 * could not run under the world that scheduled it.
 */
export class SnapshotWorldUnresolved extends Schema.TaggedError<SnapshotWorldUnresolved>()(
  "SnapshotWorldUnresolved",
  {
    name: Schema.String,
    reason: Schema.Literals(["missing", "ambiguous"]),
    message: Schema.String,
  },
) {}

/**
 * A world holds work a snapshot does not carry: attempts held for `apply`, or,
 * when it restores, commits of its own.
 */
export class SnapshotWorldBusy extends Schema.TaggedError<SnapshotWorldBusy>()(
  "SnapshotWorldBusy",
  {
    version: Schema.Int,
    held: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/**
 * A snapshot marks a secret the restore was not given, so the raw value its
 * replay needs is not in memory.
 */
export class SnapshotSecretMissing extends Schema.TaggedError<SnapshotSecretMissing>()(
  "SnapshotSecretMissing",
  { ref: Schema.String, message: Schema.String },
) {}

/**
 * A world is running work a snapshot taken or restored now would split: calls
 * from the test, scheduler walks, or function executions, nested and detached
 * ones included.
 */
export class SnapshotWorldRunning extends Schema.TaggedError<SnapshotWorldRunning>()(
  "SnapshotWorldRunning",
  {
    registry: Schema.Literals(["running", "walks", "functions"]),
    count: Schema.Int,
    message: Schema.String,
  },
) {}

/**
 * A world has subscribers, whose identity versions a restore would rewind.
 * Subscriptions are live client state, so a restore needs a world with none.
 */
export class SnapshotSubscribed extends Schema.TaggedError<SnapshotSubscribed>()(
  "SnapshotSubscribed",
  { subscribers: Schema.Int, message: Schema.String },
) {}

/**
 * A snapshot's identity counters stand at or behind an identity its state
 * already holds, so the next allocation would reuse one.
 */
export class SnapshotAllocatorBehind extends Schema.TaggedError<SnapshotAllocatorBehind>()(
  "SnapshotAllocatorBehind",
  {
    allocator: Schema.Literals([
      "nextDocumentId",
      "lastCreationTime",
      "nextAttemptId",
      "identityEpoch",
    ]),
    value: Schema.Finite,
    required: Schema.Finite,
    message: Schema.String,
  },
) {}

/**
 * A snapshot's rows are not what its write log publishes: a row filed under
 * another table or an unregistered component, a version the log does not give
 * it, or a log change whose before value is not the row it replaced.
 */
export class SnapshotRowInconsistent extends Schema.TaggedError<SnapshotRowInconsistent>()(
  "SnapshotRowInconsistent",
  {
    componentPath: Schema.String,
    id: Schema.String,
    reason: Schema.Literals([
      "id",
      "component",
      "log",
      "row",
      "systemFields",
      "duplicate",
    ]),
    message: Schema.String,
  },
) {}

/**
 * A snapshot's commit timestamps do not strictly increase through its write
 * log, or its latest commit timestamp is not the log's last.
 */
export class SnapshotTimestampInconsistent extends Schema.TaggedError<SnapshotTimestampInconsistent>()(
  "SnapshotTimestampInconsistent",
  { version: Schema.Int, commitTs: Schema.String, message: Schema.String },
) {}

/**
 * A snapshot's jobs and job rows disagree: a job with no row, a row with no
 * job, a job left running, or a target no registered component exports.
 */
export class SnapshotJobInconsistent extends Schema.TaggedError<SnapshotJobInconsistent>()(
  "SnapshotJobInconsistent",
  {
    id: Schema.String,
    reason: Schema.Literals([
      "row",
      "untargeted",
      "inProgress",
      "component",
      "function",
      "duplicate",
    ]),
    message: Schema.String,
  },
) {}
