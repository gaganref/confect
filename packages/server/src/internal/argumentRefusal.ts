import { pipe } from "effect/Function";
import * as Str from "effect/String";

/**
 * Whether an error a nested Convex call rejected with is Convex refusing the
 * call's arguments: the real backend's `ArgumentValidationError: ` message, or
 * convex-test's `Validator error:`. Neither carries a class, name or code, so
 * only the nested-call boundary may read it.
 */
export const isRefusal = (error: unknown): error is Error =>
  error instanceof Error &&
  (pipe(error.message, Str.startsWith("ArgumentValidationError: ")) ||
    pipe(error.message, Str.startsWith("Validator error:")));
