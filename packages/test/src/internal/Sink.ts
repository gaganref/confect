import type { GenericValidator } from "convex/values";

/**
 * The component path a callback sink's handles name. No registered component
 * can take it, since a component name is an identifier.
 */
export const SINK = "~sink";

/**
 * Answers a call to a handle under {@link SINK}, in place of a registered
 * function. `args` and `returns` are the declared validators of the slot a
 * handle names, its udf path. The kernel checks a call's arguments against
 * `args` before `call` sees them, and `call`'s answer against `returns`, as the
 * binary checks a handle's target both ways. `call` gets the slot, the
 * arguments, and the function that called it, or `undefined` for a scheduled
 * job. Its answer is the call's encoded return, or a rejection shaped as a
 * function's thrown error leaves it, a `ConvexError`'s data serialized to JSON
 * text, which the caller receives as a nested call's error.
 */
export interface Sink {
  readonly args: (slot: string) => GenericValidator | undefined;
  readonly returns: (slot: string) => GenericValidator | undefined;
  readonly call: (command: {
    readonly slot: string;
    readonly args: unknown;
    readonly caller:
      | { readonly componentPath: string; readonly functionName: string }
      | undefined;
  }) => Promise<unknown>;
}
