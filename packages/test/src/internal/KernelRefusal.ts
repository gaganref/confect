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
 * A refusal a test can read: what failed, why the kernel refuses it, what to do
 * instead, and where the testing guide explains it. `UndeclaredFetch` is the
 * kernel's one deliberate departure from the binary, which performs a raw
 * `fetch` in an action.
 */
export class BackendRefusal extends Schema.TaggedError<BackendRefusal>()(
  "BackendRefusal",
  {
    reason: Schema.Literal("UndeclaredFetch"),
    componentPath: Schema.String,
    functionName: Schema.String,
    host: Schema.String,
    failed: Schema.String,
    because: Schema.String,
    instead: Schema.String,
    docs: Schema.TemplateLiteral([
      "https://",
      Schema.String,
      "#",
      Schema.String,
    ]),
    message: Schema.String,
  },
) {}

const egressDocs =
  "https://confect.dev/guides/testing#reach-the-network-from-an-action" as const;

/**
 * The action at `componentPath` and `functionName` fetched `host` directly.
 */
export const undeclaredFetch = (
  componentPath: string,
  functionName: string,
  host: string,
) => {
  const action =
    componentPath === ""
      ? `The action ${functionName}`
      : `The action ${functionName} in component "${componentPath}"`;
  const failed = `${action} fetched ${host} directly.`;
  const because =
    "The test kernel performs no raw fetch, so a test never reaches the network and a run replays.";
  const instead = `Reach ${host} through a provider port. The kernel holds each port call as a command the test answers.`;
  return new BackendRefusal({
    reason: "UndeclaredFetch",
    componentPath,
    functionName,
    host,
    failed,
    because,
    instead,
    docs: egressDocs,
    message: `${failed} ${because} ${instead} See ${egressDocs}.`,
  });
};

/**
 * `answer` named a command the kernel does not hold: it was already answered,
 * or never held.
 */
export class StaleCommand extends Schema.TaggedError<StaleCommand>()(
  "StaleCommand",
  { id: Schema.String, message: Schema.String },
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
