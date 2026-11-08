---
"@confect/cli": patch
---

A host's first `confect codegen` succeeds when a spec the declaration reaches, such as one behind a mount's `refs` arg, imports `_generated/components`, and a second run writes nothing. Codegen writes a provisional registry before it loads `confect/app.ts`, and the manifest `digest` no longer hashes the registry, which codegen derives from the declaration. A host whose declaration already reached the registry sees its digest change once.
