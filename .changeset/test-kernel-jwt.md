---
"@confect/test": patch
---

The test kernel verifies a token a test presents against the app's `auth.config` providers, as the Convex binary does, and signs `ctx.auth.signJwt` tokens with a deployment key whose JWKS it serves. The key's seed is drawn from the test world's random stream, which `TestConfect.layer`'s `seed` sets, and it signs by RFC 6979, so a history that stores a signed token replays byte for byte. A snapshot carries the seed as a secret marker, and a restore given the source's secrets verifies the same tokens. An HTTP action under a presented token runs as it does on Convex: a refused token's error is thrown only when the handler calls `getUserIdentity`. The snapshot format is now version 4. `@confect/test` now depends on `@noble/curves` and `@noble/hashes` 2.4.0 for that signer.
