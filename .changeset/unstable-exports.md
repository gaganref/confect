---
"@confect/alchemy": patch
"@confect/core": patch
"@confect/server": patch
---

Exports whose types expose an unstable Effect API are tagged `@stability unstable`. They are alchemy's `Code` providers and layers, the local `DeployKey` and `Deployment` layers and `ConvexClient.layer`; core's `App.Api`, `Http.Http`, `Http.Any`, `Http.make` and `Http.routes`, with the `App` and `Http` namespaces of the package root; and server's `HttpRouter.withBodyLimit`. Nothing else changes.
