---
"@confect/core": minor
"@confect/cli": minor
"@confect/alchemy": minor
---

A manifest section's `render` and `verify.check` now receive `deployment`, the kind of deployment codegen generates for: `"local"`, `"cloud"`, `"self-hosted"` or `"unknown"`. A section that relaxes a rule only on a backend you run yourself, such as a test token issuer, can refuse it everywhere else. Treat `"unknown"` as hosted.

```ts
verify: {
  match: (path) => path === "auth.ts",
  check: ({ deployment }) =>
    deployment === "local"
      ? []
      : [`a test issuer needs a local deployment, not ${deployment}`],
},
```

`confect codegen` and `confect dev` take `--deployment-kind <local|cloud|self-hosted>`. Without it, they read `CONFECT_DEPLOYMENT_KIND` from the environment, never from a file. A flag and a variable that disagree, or a variable that names no kind, give `"unknown"`. With neither, codegen reads the variables the Convex CLI selects a deployment with, from the environment, then `.env.local`, then `.env`. A variable set at one layer hides the layers below it, even when it is empty, as in the Convex CLI. `CONVEX_DEPLOYMENT` starting `local:` or naming an `anonymous-` deployment is `"local"`. `dev:`, `prod:` and `preview:` deployments and any deploy key in `CONVEX_DEPLOY_KEY` or `CONVEX_DEPLOYMENT_TOKEN` are `"cloud"`. `CONVEX_SELF_HOSTED_URL` with `CONVEX_SELF_HOSTED_ADMIN_KEY` is `"self-hosted"`. No variables, a value the Convex CLI would refuse, or variables that name different kinds give `"unknown"`. `confect dev` decides once when it starts.

`Confect.Backend` sets `CONFECT_DEPLOYMENT_KIND=cloud` for the `prepare` command it runs before a push, or `local` under the local providers, so the push's target wins over the backend directory's environment files. A custom `prepare` such as `pnpm exec confect codegen` inherits it, and its arguments pass through unchanged. The CLI and `@confect/alchemy` must be on the same release, as before. A section that ignores `deployment` generates the same files as before.
