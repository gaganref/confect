---
"@confect/cli": minor
---

Generate provider families into `convex/auth.config.ts` and `confect/_generated/auth.providers.ts` as reads of the deployment's env, and refuse two families that read one env value. With a family, `auth.providers.ts` exports `providers` as a function that reads the env on each call, so a warm Node action sees an env change. A backend without a family generates the same files as before.
