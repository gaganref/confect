---
"@confect/test": minor
---

`TestConfect.layer` takes a `target` option in every form: `layer(app, { target })`, `layer(app, registry, { target })` and `layer(schema, convexSchema, modules, { target, ... })`. `"kernel"` runs every function and component the layer registers on Confect's test kernel, `registerComponent`'s `standing` included. There, scheduled functions run on the kernel's own clock, and `finishAllScheduledFunctions` ends with standing jobs pending, or fails with `DrainBudgetExceeded` when a self-rescheduling function is undeclared. The default, `"convex-test"`, keeps every current test on convex-test. The option is removed once the kernel replaces convex-test. `@confect/test/internal/*` stays unexported.
