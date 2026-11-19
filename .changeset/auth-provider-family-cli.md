---
"@confect/cli": minor
---

Generate provider families into `convex/auth.config.ts` and `confect/_generated/auth.providers.ts` as reads of the deployment's env, expanded when Convex loads them, and refuse two families that read one env value. A backend without a family generates the same files as before.
