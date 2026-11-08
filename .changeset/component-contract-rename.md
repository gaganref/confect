---
"@confect/core": minor
"@confect/cli": minor
---

Rename the published-contract builder `Component.make(spec, scope, tables)` to `Component.contract`. Generated `_generated/component.ts` files call the new name; rerun `confect codegen` to regenerate them.
