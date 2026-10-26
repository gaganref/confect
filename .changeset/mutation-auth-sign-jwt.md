---
"@confect/server": minor
"@confect/cli": minor
"@confect/test": minor
---

Add `Auth.MutationAuth` and generated `MutationAuth` services for app and component mutations to sign deployment-issued JWTs with Convex `SignJwtOptions`.

Require convex-test 0.0.65 or later in `@confect/test` for deployment JWT signing and `t.jwks()`.
