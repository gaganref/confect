import * as Schema from "effect/Schema";
import * as Array from "effect/Array";

/**
 * The kernel never answers this operation in process. Only the binary does.
 */
export class RequiresBinary extends Schema.TaggedError<
  RequiresBinary,
  { readonly brand: unique symbol }
>()("RequiresBinary", {
  operation: Schema.Literals([
    "textSearch",
    "vectorSearch",
    "storageUpload",
    "storageDownload",
    "subtleGenerateKey",
    "subtleEncrypt",
    "subtleSign",
    "oidcDiscovery",
    "remoteJwks",
  ]),
  message: Schema.String,
}) {}

/**
 * A later kernel row supplies this operation. Until then the kernel refuses it
 * rather than answer with convex-test's behaviour.
 */
export class KernelRowPending extends Schema.TaggedError<
  KernelRowPending,
  { readonly brand: unique symbol }
>()("KernelRowPending", {
  operation: Schema.String,
  row: Schema.Int,
  message: Schema.String,
}) {}

/**
 * A component was registered after the test backend opened, so its modules
 * would load after a function had already run.
 */
export class RegisteredAfterOpen extends Schema.TaggedError<
  RegisteredAfterOpen,
  { readonly brand: unique symbol }
>()("RegisteredAfterOpen", {
  componentPath: Schema.String,
  message: Schema.String,
}) {}

/**
 * Every attempt of a mutation read data a commit changed before it could
 * publish. The kernel gives up on attempt 5.
 */
export class OptimisticConcurrencyControlFailure extends Schema.TaggedError<
  OptimisticConcurrencyControlFailure,
  { readonly brand: unique symbol }
>()("OptimisticConcurrencyControlFailure", {
  attempts: Schema.Int,
  message: Schema.String,
}) {}

/**
 * A syscall reached a mutation's attempt after the mutation returned and its
 * syscalls drained, so the attempt was already held or published.
 */
export class ClosedAttempt extends Schema.TaggedError<
  ClosedAttempt,
  { readonly brand: unique symbol }
>()("ClosedAttempt", { operation: Schema.String, message: Schema.String }) {}

/**
 * `apply` named an attempt the kernel does not hold: it was already applied, or
 * never prepared.
 */
export class StaleAttempt extends Schema.TaggedError<
  StaleAttempt,
  { readonly brand: unique symbol }
>()("StaleAttempt", { id: Schema.String, message: Schema.String }) {}

/**
 * The runtime answered a commit timestamp no greater than the previous
 * commit's.
 */
export class CommitTsNotIncreasing extends Schema.TaggedError<
  CommitTsNotIncreasing,
  { readonly brand: unique symbol }
>()("CommitTsNotIncreasing", {
  version: Schema.Int,
  previous: Schema.BigInt,
  commitTs: Schema.BigInt,
  message: Schema.String,
}) {}

/**
 * Draining scheduled functions ran its budget of jobs and work still remained.
 * A self-rescheduling function keeps the drain from ending unless its kit
 * declares it standing.
 */
export class DrainBudgetExceeded extends Schema.TaggedError<
  DrainBudgetExceeded,
  { readonly brand: unique symbol }
>()("DrainBudgetExceeded", {
  budget: Schema.Int,
  pending: Schema.Array(
    Schema.Struct({ componentPath: Schema.String, name: Schema.String }),
  ),
  message: Schema.String,
}) {}

/**
 * A component declared a standing source its modules do not export.
 */
export class UnknownStandingSource extends Schema.TaggedError<
  UnknownStandingSource,
  { readonly brand: unique symbol }
>()("UnknownStandingSource", {
  componentPath: Schema.String,
  functionName: Schema.String,
  message: Schema.String,
}) {}

/**
 * A component's `crons.ts` declares a job the binary refuses at push: a
 * schedule it cannot read, or a function that is no mutation or action.
 */
export class InvalidCron extends Schema.TaggedError<
  InvalidCron,
  { readonly brand: unique symbol }
>()("InvalidCron", {
  componentPath: Schema.String,
  cronName: Schema.String,
  message: Schema.String,
}) {}

/**
 * The token a test presented was refused before any function ran, as the binary
 * answers a client's request with 401. `code` is the binary's: `NoAuthProvider`
 * when no provider's issuer and audience match the token, and
 * `InvalidAuthHeader` for every other failure.
 */
export class InvalidToken extends Schema.TaggedError<
  InvalidToken,
  { readonly brand: unique symbol }
>()("InvalidToken", {
  code: Schema.Literals(["NoAuthProvider", "InvalidAuthHeader"]),
  message: Schema.String,
}) {}

export const isInvalidToken = Schema.is(InvalidToken);

/**
 * The app's `auth.config` declares a provider the binary would refuse at push.
 * `index` is the provider's position, or -1 for the config itself.
 */
export class InvalidAuthConfig extends Schema.TaggedError<
  InvalidAuthConfig,
  { readonly brand: unique symbol }
>()("InvalidAuthConfig", { index: Schema.Int, message: Schema.String }) {}

/**
 * The deployment's signing key is drawn on first use from a test world's random
 * stream, and neither an invocation was bound nor the backend was given a world
 * to draw it from. The kernel holds no generator of its own.
 */
export class SigningKeyRandomUnavailable extends Schema.TaggedError<
  SigningKeyRandomUnavailable,
  { readonly brand: unique symbol }
>()("SigningKeyRandomUnavailable", { message: Schema.String }) {}

/**
 * A cron job runs on a clock schedule, which Convex delays by a random draw,
 * and no test world was bound when the backend opened to draw it from. The
 * kernel holds no generator of its own.
 */
export class CronRandomUnavailable extends Schema.TaggedError<
  CronRandomUnavailable,
  { readonly brand: unique symbol }
>()("CronRandomUnavailable", {
  componentPath: Schema.String,
  cronName: Schema.String,
  message: Schema.String,
}) {}

/**
 * A module drew a random value while it loaded, and no test world was bound
 * when the backend opened, nor given to the backend, to draw it from. The
 * binary seeds a module's load once per push; the kernel holds no generator of
 * its own.
 */
export class LoadRandomUnavailable extends Schema.TaggedError<
  LoadRandomUnavailable,
  { readonly brand: unique symbol }
>()("LoadRandomUnavailable", {
  componentPath: Schema.String,
  modulePath: Schema.String,
  message: Schema.String,
}) {}

/**
 * A function drew a random value, and neither an invocation bound to it nor the
 * backend's own world supplied a stream to draw from. The binary seeds every
 * function; the kernel holds no generator of its own.
 */
export class FunctionRandomUnavailable extends Schema.TaggedError<
  FunctionRandomUnavailable,
  { readonly brand: unique symbol }
>()("FunctionRandomUnavailable", {
  componentPath: Schema.String,
  udfPath: Schema.String,
  message: Schema.String,
}) {}

/**
 * Computing a cron job's next run reaches arithmetic that aborts the Convex
 * binary, which is built with overflow checks.
 */
export class CronAbortsBinary extends Schema.TaggedError<
  CronAbortsBinary,
  { readonly brand: unique symbol }
>()("CronAbortsBinary", {
  componentPath: Schema.String,
  cronName: Schema.String,
  date: Schema.String,
  message: Schema.String,
}) {}

/**
 * A snapshot's cron jobs are not the ones the restoring app declares: one the
 * snapshot holds is not declared, one declared is not in the snapshot, or a
 * declaration's function, arguments or schedule changed. A restore would run
 * the snapshot's runs for jobs the app no longer declares as they were.
 */
export class SnapshotCronMismatch extends Schema.TaggedError<
  SnapshotCronMismatch,
  { readonly brand: unique symbol }
>()("SnapshotCronMismatch", {
  componentPath: Schema.String,
  cronName: Schema.String,
  reason: Schema.Literals(["undeclared", "missing", "changed"]),
  message: Schema.String,
}) {}

export const requiresBinary = (operation: RequiresBinary["operation"]) =>
  RequiresBinary.make({
    operation,
    message: `The test kernel does not simulate ${operation}. Run this case against the Convex binary.`,
  });

export const rowPending = (operation: string, row: number) =>
  KernelRowPending.make({
    operation,
    row,
    message: `The test kernel supplies ${operation} in build-order row ${row}.`,
  });

/**
 * Snapshot bytes are not a kernel snapshot this kernel reads: an unknown
 * header, a body that is not the snapshot's JSON, or a value that does not
 * decode.
 */
export class SnapshotMalformed extends Schema.TaggedError<
  SnapshotMalformed,
  { readonly brand: unique symbol }
>()("SnapshotMalformed", { reason: Schema.String, message: Schema.String }) {}

/**
 * A snapshot's body does not hash to the digest its header names, so its bytes
 * changed after export.
 */
export class SnapshotDigestMismatch extends Schema.TaggedError<
  SnapshotDigestMismatch,
  { readonly brand: unique symbol }
>()("SnapshotDigestMismatch", {
  expected: Schema.String,
  actual: Schema.String,
  message: Schema.String,
}) {}

/**
 * A snapshot's components are not the components registered on the world
 * restoring it.
 */
export class SnapshotComponentMismatch extends Schema.TaggedError<
  SnapshotComponentMismatch,
  { readonly brand: unique symbol }
>()("SnapshotComponentMismatch", {
  snapshot: Schema.Array(Schema.String),
  registered: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/**
 * A job's test world is named by no world, or by more than one, so the job
 * could not run under the world that scheduled it.
 */
export class SnapshotWorldUnresolved extends Schema.TaggedError<
  SnapshotWorldUnresolved,
  { readonly brand: unique symbol }
>()("SnapshotWorldUnresolved", {
  worldName: Schema.String,
  reason: Schema.Literals(["missing", "ambiguous"]),
  message: Schema.String,
}) {}

/**
 * A world holds work a snapshot does not carry: attempts held for `apply`, or,
 * when it restores, commits of its own.
 */
export class SnapshotWorldBusy extends Schema.TaggedError<
  SnapshotWorldBusy,
  { readonly brand: unique symbol }
>()("SnapshotWorldBusy", {
  version: Schema.Int,
  held: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/**
 * A snapshot marks a secret the restore was not given, so the raw value its
 * replay needs is not in memory.
 */
export class SnapshotSecretMissing extends Schema.TaggedError<
  SnapshotSecretMissing,
  { readonly brand: unique symbol }
>()("SnapshotSecretMissing", { ref: Schema.String, message: Schema.String }) {}

/**
 * A world is running work a snapshot taken or restored now would split: calls
 * from the test, scheduler walks, or function executions, nested and detached
 * ones included.
 */
export class SnapshotWorldRunning extends Schema.TaggedError<
  SnapshotWorldRunning,
  { readonly brand: unique symbol }
>()("SnapshotWorldRunning", {
  registry: Schema.Literals(["running", "walks", "functions"]),
  count: Schema.Int,
  message: Schema.String,
}) {}

/**
 * A world has subscribers, whose identity versions a restore would rewind.
 * Subscriptions are live client state, so a restore needs a world with none.
 */
export class SnapshotSubscribed extends Schema.TaggedError<
  SnapshotSubscribed,
  { readonly brand: unique symbol }
>()("SnapshotSubscribed", {
  subscribers: Schema.Int,
  message: Schema.String,
}) {}

/**
 * A snapshot's identity counters stand at or behind an identity its state
 * already holds, so the next allocation would reuse one.
 */
export class SnapshotAllocatorBehind extends Schema.TaggedError<
  SnapshotAllocatorBehind,
  { readonly brand: unique symbol }
>()("SnapshotAllocatorBehind", {
  allocator: Schema.Literals([
    "nextDocumentId",
    "lastCreationTime",
    "nextAttemptId",
    "identityEpoch",
    "nextFile",
    "nextUploadToken",
  ]),
  value: Schema.Finite,
  required: Schema.Finite,
  message: Schema.String,
}) {}

/**
 * A snapshot's rows are not what its write log publishes: a row filed under
 * another table or an unregistered component, a version the log does not give
 * it, or a log change whose before value is not the row it replaced.
 */
export class SnapshotRowInconsistent extends Schema.TaggedError<
  SnapshotRowInconsistent,
  { readonly brand: unique symbol }
>()("SnapshotRowInconsistent", {
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
}) {}

/**
 * A snapshot's stored files and `_storage` rows disagree: a file with no
 * committed row in its component, a row with no file, bytes whose SHA-256 or
 * size is not the row's, a storage UUID the kernel would not mint or that two
 * files share, or a file listed twice.
 */
export class SnapshotFileInconsistent extends Schema.TaggedError<
  SnapshotFileInconsistent,
  { readonly brand: unique symbol }
>()("SnapshotFileInconsistent", {
  componentPath: Schema.String,
  id: Schema.String,
  reason: Schema.Literals([
    "row",
    "untracked",
    "digest",
    "size",
    "uuid",
    "duplicate",
  ]),
  message: Schema.String,
}) {}

/**
 * A snapshot's commit timestamps do not strictly increase through its write
 * log, or its latest commit timestamp is not the log's last.
 */
export class SnapshotTimestampInconsistent extends Schema.TaggedError<
  SnapshotTimestampInconsistent,
  { readonly brand: unique symbol }
>()("SnapshotTimestampInconsistent", {
  version: Schema.Int,
  commitTs: Schema.String,
  message: Schema.String,
}) {}

/**
 * A snapshot's jobs and job rows disagree: a job with no row, a row with no
 * job, a job left running, or a target no registered component exports.
 */
export class SnapshotJobInconsistent extends Schema.TaggedError<
  SnapshotJobInconsistent,
  { readonly brand: unique symbol }
>()("SnapshotJobInconsistent", {
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
}) {}

/**
 * Whether `error` is the kernel refusing what it does not simulate or a misuse
 * of its own API, rather than a failure the binary would raise too. A refusal
 * reaching a function never becomes that function's own failure, such as an
 * HTTP route's 500.
 */
const refusals = Array.map(
  [
    RequiresBinary,
    KernelRowPending,
    FunctionRandomUnavailable,
    RegisteredAfterOpen,
    ClosedAttempt,
    StaleAttempt,
    CommitTsNotIncreasing,
    UnknownStandingSource,
  ],
  (refusal) => Schema.is(refusal),
);

export const isKernelRefusal = (error: unknown): boolean =>
  Array.some(refusals, (is) => is(error));
