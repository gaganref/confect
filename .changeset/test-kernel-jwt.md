---
"@confect/test": patch
---

The test kernel verifies a token a test presents against the app's `auth.config` providers, as the Convex binary does, and signs `ctx.auth.signJwt` tokens with a deployment key whose JWKS it serves. The key comes from the kernel runtime's new optional `random` stream and signs by RFC 6979, so a history that stores a signed token replays byte for byte. `@confect/test` now depends on `@noble/curves` and `@noble/hashes` 2.4.0 for that signer.
