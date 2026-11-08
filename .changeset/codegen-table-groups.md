---
"@confect/cli": minor
---

A component's generated `_generated/component.ts` passes each table to `Component.contract`, so `Component.groups(contract)` returns the groups its tables declare with `.group`. The file binds its own imports with a leading `$`. Rerun `confect codegen` for each component.
