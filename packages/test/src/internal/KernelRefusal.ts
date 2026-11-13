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
 * A component's `crons.ts` declares a job the binary refuses at push: a
 * schedule it cannot read, or a function that is no mutation or action.
 */
export class InvalidCron extends Schema.TaggedError<InvalidCron>()(
  "InvalidCron",
  { componentPath: Schema.String, name: Schema.String, message: Schema.String },
) {}

/**
 * A cron job runs on a clock schedule, which Convex delays by a random draw,
 * and no test world was bound when the backend opened to draw it from. The
 * kernel holds no generator of its own.
 */
export class CronRandomUnavailable extends Schema.TaggedError<CronRandomUnavailable>()(
  "CronRandomUnavailable",
  { componentPath: Schema.String, name: Schema.String, message: Schema.String },
) {}

/**
 * Computing a cron job's next run reaches arithmetic that aborts the Convex
 * binary, which is built with overflow checks.
 */
export class CronAbortsBinary extends Schema.TaggedError<CronAbortsBinary>()(
  "CronAbortsBinary",
  {
    componentPath: Schema.String,
    name: Schema.String,
    date: Schema.String,
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
