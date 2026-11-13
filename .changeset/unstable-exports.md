---
"@confect/alchemy": patch
"@confect/core": patch
"@confect/server": patch
---

Exports whose types expose an unstable Effect API are tagged `@stability unstable`. They are alchemy's `Code` providers and layers, the local `DeployKey` provider and layer, the local `Deployment` layer, `ConvexClient.layer` and `providers`, with the `Convex` namespace of the package root; core's `App.Api`, `Http.Http`, `Http.Any`, `Http.make` and `Http.routes`, with the `App` and `Http` namespaces of the package root; and server's `HttpRouter.withBodyLimit`. Nothing else changes.
