---
"@confect/alchemy": major
---

Deployment credentials come from a run-time `DeploymentAccess` service and never enter Alchemy state. `Confect.Backend`, `Convex.Code`, `Convex.EnvironmentVariables` and `Convex.LogStream` no longer take `deployKey`, and `EnvironmentVariablesAttributes` no longer holds one. Choose the access with `Convex.providers({ access })`: `Convex.DeploymentAccess.grant`, the default, uses the management login and, for the push, the key Convex returns for an OAuth login, after proving no key was minted; `Convex.DeploymentAccess.deployKey(key)` serves the one deployment a supplied key names. Local providers read the local backend's admin key at run time.

Migration: delete each `deployKey` prop. A stack that read `CONVEX_DEPLOY_KEY` passes `access: Convex.DeploymentAccess.deployKey(Config.Redacted("CONVEX_DEPLOY_KEY"))` to `Convex.providers`. A stack that passed `key.deployKey` from `Convex.DeployKey` drops the prop, and under an OAuth login drops the `DeployKey` too. A team access token mints a key under `grant`, which fails with `DeploymentGrantUnproven`; supply a deploy key instead. Under `alchemy dev`, remove `Convex.DeployKey`, which now fails with `DeployKeyUnavailableLocally`.

`Convex.DeployKey` deletes by the key name Convex lists, never by its secret, and fails with `DeployKeyNotMinted` when Convex lists no new key after a create. `ConvexClient.deleteDeployKey` takes a key name. Deployment calls on `ConvexClient` accept an absent key, meaning the management login. `DeploymentAccess` and the `EnvironmentVariables` and `LogStream` providers and layers are marked unstable.
