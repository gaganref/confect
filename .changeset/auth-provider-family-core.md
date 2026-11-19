---
"@confect/core": minor
---

Add `Auth.family`, which declares a set of `customJwt` providers whose issuers come from one env value, and `AuthFamily`, which parses that value, expands it into Convex providers, lists its members at request time, and matches an issuer to its provider. An invalid or empty value fails the push and lists no member at request time. An issuer that a family shares with another provider fails the push, and `AuthFamily.lookup` returns every provider of a shared issuer.
