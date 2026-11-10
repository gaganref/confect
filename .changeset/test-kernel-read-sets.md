---
"@confect/test": patch
---

The internal test kernel records each attempt's read set and checks it at commit. A top-level mutation can run to its commit point and be held, then applied, which publishes it, holds one next attempt on a conflict, or gives up on attempt 5. Concurrent mutations on the kernel conflict and rerun instead of taking turns. Commit timestamps come from a supplied runtime and strictly increase. A write that a detached fiber makes after its handler settles commits with its mutation, and a syscall after the mutation's commit point is refused. The public `TestConfect` API is unchanged and still runs on convex-test.
