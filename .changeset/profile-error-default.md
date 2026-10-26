---
"@confect/core": minor
---

Pass `Schema.Never` to a profile's `error` wrapper when a function declares no error, so the profile can add an error to every function's union.

Refuse error wrappers that leave the empty union empty, so hook return types agree with their runtime result.
