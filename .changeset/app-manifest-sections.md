---
"@confect/core": minor
"@confect/cli": minor
---

Declare a backend's manifest sections once, in `App.make({ manifestSections })`. Codegen describes every registered function into each declared section and writes each section's `_generated` file, even for a backend with no functions. The profile `manifest` option and `FunctionSpec.manifestSections` are removed, and codegen refuses a function spec that still carries `manifestSections`.
