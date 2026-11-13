---
"@confect/alchemy": major
---

Two errors rename their `name` field, which hid the error's own name in logs and `String(error)`.

- `DeployKeyRecoveryRequired.name` is now `keyName`.
- `AmbiguousProject.name` is now `projectName`.

`String(error)` for these two errors now prints the error's tag, `DeployKeyRecoveryRequired` or `AmbiguousProject`, where it printed the old `name` value, and their `message` stays empty.

To migrate, read `keyName` or `projectName` where code read `name` from these errors.
