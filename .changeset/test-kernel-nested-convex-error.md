---
"@confect/test": patch
---

Fix the test kernel decoding a nested `ConvexError`'s data twice. When a query, mutation or HTTP action caught a `ConvexError` thrown by a function it called through `ctx.runQuery`, `ctx.runMutation` or `ctx.runAction`, data holding an int64 reached it as `Error: Unexpected type of 42`, and bytes as an empty object. The kernel now hands the caller's syscall the data as Convex JSON, as the Convex backend does, so the caller decodes it once and catches the `ConvexError` with the data that was thrown.
