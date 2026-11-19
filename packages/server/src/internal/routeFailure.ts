import type * as Guard from "../Guard.js";

/**
 * Why each route response the guard receives is a server error, keyed by that
 * response. Confect builds the response, so product code never holds the key.
 *
 * @internal
 */
export const failures = new WeakMap<object, Guard.Failure>();
