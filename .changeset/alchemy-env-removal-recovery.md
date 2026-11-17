---
"@confect/alchemy": patch
---

Fix `EnvironmentVariables` removals with `driftPolicy: "error"` so a rerun after a failed state write releases already absent names without another environment write.
