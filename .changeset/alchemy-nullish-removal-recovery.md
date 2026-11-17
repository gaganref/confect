---
"@confect/alchemy": patch
---

Fix `Convex.EnvironmentVariables` recovery after a lost removal state write with `driftPolicy: "error"` when a desired entry resolves to `null` or `undefined`, without another environment write.
