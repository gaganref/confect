"use node";

import { actionGeneric } from "convex/server";

/**
 * Which of Node's scheduling globals the runtime defines, by `typeof`.
 */
const surface = () => ({
  setImmediate: typeof setImmediate,
  queueMicrotask: typeof queueMicrotask,
  MessageChannel: typeof MessageChannel,
});

// The binary's Node executor loads this module in Node.
const atLoad = surface();

export const action = actionGeneric({
  args: {},
  handler: () => Promise.resolve({ atLoad, inFunction: surface() }),
});
