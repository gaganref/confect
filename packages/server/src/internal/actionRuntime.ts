/**
 * The runtime a Confect action runs in, marked on the function Confect
 * registers: `true` for a Node action, which Convex runs in Node, `false` for
 * an action Convex runs in its isolate. `@confect/test`'s kernel reads it,
 * since a module's `"use node"` directive is gone once the module loads. A
 * plain Convex action carries no mark.
 */
const nodeAction = Symbol.for("@confect/server/NodeAction");

export const markActionRuntime = <F extends object>(
  registered: F,
  node: boolean,
): F => Object.defineProperty(registered, nodeAction, { value: node });
