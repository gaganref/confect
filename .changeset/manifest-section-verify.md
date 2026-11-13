---
"@confect/core": minor
"@confect/cli": minor
---

Add `generate.verify` to manifest sections. Codegen runs it once every `_generated` file exists, bundling the `confect/` files its `match` accepts with the declaration's plugins, and fails with each string its `check` returns.
