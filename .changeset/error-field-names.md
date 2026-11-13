---
"@confect/alchemy": major
---

Two errors rename their `name` field, which hid the error's own name in logs and `String(error)`.

- `DeployKeyRecoveryRequired.name` is now `keyName`.
- `AmbiguousProject.name` is now `projectName`.

To migrate, read `keyName` or `projectName` where code read `name` from these errors.
