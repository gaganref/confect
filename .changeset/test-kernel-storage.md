---
"@confect/test": patch
---

Add an internal test kernel to `@confect/test`. It keeps committed rows per component and runs each query and mutation as an attempt over its own pending writes, so a failed mutation publishes nothing and a host mutation publishes its component writes in the same commit. As on Convex, a function's database reads, writes and nested calls run one at a time in the order it made them, so a caller's write made after its nested mutation wins over that mutation's. It loads every module Convex would deploy before the first function runs. The fork's mock-backend suite now also runs on the kernel through a shim with convex-test's `convexTest` signature. The public `TestConfect` API is unchanged and still runs on convex-test.
