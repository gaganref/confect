---
"@confect/core": minor
---

`Auth.siteUrl` takes a `Mount.make` mount with an `httpPrefix` and points at that mount's HTTP routes. A mount's type records whether it was given a prefix, so a mount without one fails to typecheck there.
