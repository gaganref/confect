---
"@confect/server": patch
---

Inspect the full handler cause before encoding a declared error. Mixed causes, multiple failures, interruptions and error-encoding failures now take the defect path instead of exposing a declared error that hides another failure.
