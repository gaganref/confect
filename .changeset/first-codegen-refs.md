---
"@confect/cli": patch
---

A host's first `confect codegen` succeeds when a mount passes one of the host's own refs, such as `onEvent: refs.internal.circulars.onEmailEvent`. Codegen writes `_generated/refs` and the spec it reads before it loads `confect/app.ts`, so it no longer fails with `Could not resolve "./_generated/refs"`.
