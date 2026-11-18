---
"@confect/test": patch
---

On the test kernel, each loaded copy of `@confect/test` guards its own sessions. With two copies in one process, such as a hoisted copy and a nested one, the second copy's isolate actions saw Node's `setImmediate` and `queueMicrotask`, its syscalls failed as made outside any kernel function, its queries read the host's time instead of their start time, and its provider-port calls reached the live provider. The process-wide I/O guards, `Date` wrapper, `globalThis.Convex` dispatcher, port holder and `process.env` proxy now answer for the copy that owns the innermost running function, so a function of one copy that calls into the other copy's session reaches the inner session's database, time, environment, guards and held calls. When a copy from an earlier release loaded first, opening a backend fails with the new `OlderCopyLoadedFirst` refusal instead of running unguarded; dedupe `@confect/test`, as the testing guide's "Two loaded copies" shows.
