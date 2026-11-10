---
"@confect/test": patch
---

Add an internal test kernel to `@confect/test`. It keeps committed rows per component and runs each query and mutation as an attempt over its own pending writes, so a failed mutation publishes nothing and a host mutation publishes its component writes in the same commit. It loads every module Convex would deploy before the first function runs. The fork's mock-backend suite now also runs on the kernel through a shim with convex-test's `convexTest` signature. The public `TestConfect` API is unchanged and still runs on convex-test.
