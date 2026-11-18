---
"@confect/alchemy": minor
---

Add the `Convex` Alchemy auth provider for team access tokens entered through `alchemy profile edit --add Convex`. An explicit `providers({ token })` wins over environment credentials, which win over the active profile. CI uses environment credentials unless an explicit token is supplied.
