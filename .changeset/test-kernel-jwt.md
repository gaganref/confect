---
"@confect/test": patch
---

The test kernel verifies a token a test presents against the app's `auth.config` providers, as the Convex binary does, and signs `ctx.auth.signJwt` tokens with a deployment key whose JWKS it serves.
