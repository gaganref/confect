import { actionGeneric, queryGeneric } from "convex/server";

/**
 * Which of Node's scheduling globals the runtime defines, by `typeof`.
 */
const surface = () => ({
  setImmediate: typeof setImmediate,
  queueMicrotask: typeof queueMicrotask,
  MessageChannel: typeof MessageChannel,
});

// The module has no `"use node"` directive, so the binary loads it in its
// isolate. The test kernel answers the same (`IoBans.ts`).
const atLoad = surface();

export const query = queryGeneric({
  args: {},
  handler: () => Promise.resolve({ atLoad, inFunction: surface() }),
});

export const action = actionGeneric({
  args: {},
  handler: () => Promise.resolve({ atLoad, inFunction: surface() }),
});
