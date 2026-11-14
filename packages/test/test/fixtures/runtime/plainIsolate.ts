import { actionGeneric } from "convex/server";

// No directive, so Convex's bundler runs this module in its isolate. A
// `"use node"` string after code is not a directive.
export const note = "use node";

export const surface = actionGeneric({
  args: {},
  handler: () => ({
    setImmediate: typeof setImmediate,
    queueMicrotask: typeof queueMicrotask,
  }),
});
