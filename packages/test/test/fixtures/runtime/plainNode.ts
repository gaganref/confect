// A plain Convex module that Convex's bundler runs in Node.
"use node";

import { actionGeneric } from "convex/server";

export const surface = actionGeneric({
  args: {},
  handler: () => ({
    setImmediate: typeof setImmediate,
    queueMicrotask: typeof queueMicrotask,
  }),
});
