---
"@confect/core": major
"@confect/cli": major
---

Reject environment slots named `CONVEX_SITE_URL` or `CONVEX_CLOUD_URL` in `Env.make`, `Component.make`, and mount bindings during `confect codegen`.

Convex supplies these addresses for each app and component. To migrate, remove these slots and their mount bindings, then read the built-ins with `Config.String("CONVEX_SITE_URL")`, `Config.String("CONVEX_CLOUD_URL")`, or `process.env`. If a slot carries a custom address, rename the slot and its bindings to a name such as `SERVICE_URL`.

A third-party component that requires either slot cannot be mounted. Its author must remove or rename the slot before it can be used with Confect.
