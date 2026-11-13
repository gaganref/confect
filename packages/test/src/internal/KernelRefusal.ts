import * as Schema from "effect/Schema";

/**
 * The kernel never answers this operation in process. Only the binary does.
 */
export class RequiresBinary extends Schema.TaggedError<RequiresBinary>()(
  "RequiresBinary",
  {
    operation: Schema.Literals([
      "textSearch",
      "vectorSearch",
      "oidcDiscovery",
      "remoteJwks",
    ]),
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
 * The token a test presented was refused before any function ran, as the binary
 * answers a client's request with 401. `code` is the binary's: `NoAuthProvider`
 * when no provider's issuer and audience match the token, and
 * `InvalidAuthHeader` for every other failure.
 */
export class InvalidToken extends Schema.TaggedError<InvalidToken>()(
  "InvalidToken",
  {
    code: Schema.Literals(["NoAuthProvider", "InvalidAuthHeader"]),
    message: Schema.String,
  },
) {}

/**
 * The app's `auth.config` declares a provider the binary would refuse at push.
 * `index` is the provider's position, or -1 for the config itself.
 */
export class InvalidAuthConfig extends Schema.TaggedError<InvalidAuthConfig>()(
  "InvalidAuthConfig",
  { index: Schema.Int, message: Schema.String },
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
