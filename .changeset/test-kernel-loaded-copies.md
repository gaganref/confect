---
"@confect/test": patch
---

On the test kernel, each loaded copy of `@confect/test` guards its own sessions. With two copies in one process, such as a hoisted copy and a nested one, the second copy's isolate actions saw Node's `setImmediate` and `queueMicrotask`, its syscalls failed as made outside any kernel function, its queries read the host's time instead of their start time, and its provider-port calls reached the live provider. The process-wide I/O guards, `Date` wrapper, `globalThis.Convex` dispatcher and port holder now answer for whichever copy's function is running. A copy from an earlier release still binds them only to itself, so dedupe `@confect/test` when an install holds one; the testing guide shows how.
