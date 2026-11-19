---
"@confect/test": patch
---

On the test kernel, a module load can no longer start a function through an action's `ctx.runQuery`, `ctx.runMutation` or `ctx.runAction`. These calls reach the kernel directly, not through `globalThis.Convex`, so a module whose load called through an action context it was handed, or that an action kept, ran that function and committed its writes, although the load's own syscalls were refused. Each call now fails while a module loads, with the error a load's syscall raises, as Convex runs no function at load. That includes a promise or timer callback the load started, however long after the load it runs, and a load on another loaded copy of `@confect/test`, an earlier release's included.
