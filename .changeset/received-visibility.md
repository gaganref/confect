---
"@confect/server": minor
---

Registered functions pass the function's visibility to the root span, as `visibility` on `RegisteredFunction.Received`. It is `"public"` or `"internal"`, and absent when Convex gives none.
