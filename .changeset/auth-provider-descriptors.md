---
"@confect/core": minor
"@confect/cli": minor
"@confect/test": patch
---

Add optional `family` and `name` metadata to auth providers and generate `confect/_generated/auth.providers.ts` with issuer and audience data that handlers can import without backend declarations.

Default unset deployment cloud and site URLs to convex-test values before loading backend modules, so generated provider descriptors match test tokens.
