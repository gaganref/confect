import {
  actionGeneric,
  createFunctionHandle,
  makeFunctionReference,
  mutationGeneric,
} from "convex/server";
import { v, type Value } from "convex/values";

// A function handle called with arguments its target's validator refuses. Each
// caller catches what reaches it and returns it, so a probe sees what the
// binary hands a component whose callback slot it called with bad arguments.

/**
 * The arguments the host function a handle names takes, one of each kind of
 * validator, so a refusal shows how the binary prints each value and
 * validator.
 */
export const shape = {
  token: v.string(),
  count: v.number(),
  big: v.int64(),
  flag: v.boolean(),
  nothing: v.null(),
  tags: v.array(v.string()),
  nested: v.object({ a: v.string(), b: v.optional(v.number()) }),
  kind: v.union(v.literal("a"), v.literal(2)),
  scores: v.record(v.string(), v.number()),
  blob: v.bytes(),
  anything: v.any(),
  maybe: v.optional(v.string()),
};

export const onShape = mutationGeneric({
  args: shape,
  handler: () => Promise.resolve(null),
});

/**
 * A handle for `onShape`, as a host creates one for a component's slot.
 */
export const handle = mutationGeneric({
  args: {},
  handler: () =>
    createFunctionHandle(
      makeFunctionReference<"mutation", Record<string, Value>, null>(
        "callbackArgs:onShape",
      ),
    ),
});

/**
 * What reached the caller: the error's class and message, or that the call
 * returned.
 */
export type Refusal =
  | { readonly returned: true }
  | {
      readonly returned: false;
      readonly name: string;
      readonly message: string;
    };

const refusal = (call: () => Promise<unknown>): Promise<Refusal> =>
  call().then(
    (): Refusal => ({ returned: true }),
    (error: unknown): Refusal => ({
      returned: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    }),
  );

const callerArgs = { handle: v.string(), args: v.any() };

export const fromMutation = mutationGeneric({
  args: callerArgs,
  handler: (ctx, { handle: text, args }) =>
    refusal(() => ctx.runMutation(text as never, args as Value as never)),
});

export const fromAction = actionGeneric({
  args: callerArgs,
  handler: (ctx, { handle: text, args }) =>
    refusal(() => ctx.runMutation(text as never, args as Value as never)),
});
