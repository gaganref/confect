---
"@confect/alchemy": minor
---

Run `Convex` resources against a local Convex backend under `alchemy dev`. The same stack deploys to Convex cloud with `alchemy deploy`; with `alchemy dev`, `Convex.providers()` resolves each resource to a local implementation that needs no Convex account or credentials.

```sh
pnpm alchemy dev
# choose the backend's ports from a range instead of letting the OS pick
CONFECT_LOCAL_BACKEND_PORTS=3300-3399 pnpm alchemy dev
```

A local `Convex.Deployment` downloads and runs the Convex backend release `precompiled-2026-10-06-a3538c6`, keeps its data and URL across sessions in `.alchemy/convex/<stack>/<stage>/<deployment>`, and stops when the dev session ends. `Convex.DeployKey` returns the backend's admin key, environment variables are set before code is pushed, and the data is reused by the next session; it is deleted only when the deployment is destroyed with `RemovalPolicy.destroy()`.

Pushes to one deployment from processes that share a user cache directory now wait for each other, in the cloud and locally, so concurrent pushes no longer fail with "Schema was overwritten by another push".

The `region` output of `Convex.Deployment` is now optional: cloud deployments always report it, and local deployments report it only when it was requested.
