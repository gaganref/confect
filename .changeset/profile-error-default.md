---
"@confect/core": minor
---

Pass `Schema.Never` to a profile's `error` wrapper when a function declares no error, so the profile can add an error to every function's union.

Expose the optional function description through `Profile.Info` so a profile can check it at first force.
