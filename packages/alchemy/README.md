# @confect/alchemy

Alchemy resources for Convex cloud projects, deployments, deploy keys, environment variables, and code deployments. `Confect.Backend` runs Confect codegen before deploying an existing application.

```ts
import { Confect, Convex } from "@confect/alchemy";
```

Use `Convex.providers()` in your Alchemy stack. The integration targets Alchemy `2.0.0-beta.86` and Effect v4; it does not add Alchemy dependencies to Confect's runtime packages. Plain Convex applications can use `Convex.Code` without the Confect CLI.

See the [deployment guide](https://confect.dev/guides/alchemy) for complete examples, credentials, ownership, and deletion policies.

For management requests, run `pnpm alchemy profile edit --add Convex` with `Convex.providers()` in your stack. Paste a team access token at the hidden prompt. Alchemy keeps the token in the selected profile's credential store. Protect that store. `Redacted` hides rendering and does not encrypt storage.

Use a real terminal for login. The provider accepts no token flag or stdin input. If a connected provider's token is missing or unreadable, run `pnpm alchemy profile edit --reconfigure Convex`. Remove the provider and its stored token with `pnpm alchemy profile edit --remove Convex`.

An explicit `Convex.providers({ token })` wins. Otherwise, `CONVEX_ACCESS_TOKEN` wins over the active profile. CI uses only the environment unless an explicit token is supplied. Set `CI=true` and store `CONVEX_ACCESS_TOKEN` in your CI secret store. Deploy-key-only pushes need no management login. The layer touches Alchemy's home only for profile reads. Resolved tokens are cached for the life of the provider layer.

Projects and deployments are retained by default. Treat your Alchemy state as a secret store: it contains deployment credentials and managed environment values. Code deployment runs on every apply and never deletes data when removed from a stack. Pushes to one deployment from processes that share a user cache directory never overlap.

Under `alchemy dev`, the same resources run against a local Convex backend that the integration downloads, starts, and stops with the dev session. Its data and credentials live in `.alchemy/convex/<stack>/<stage>/<deployment>`.

## Tests

Unit suites are per-module under `test/`. Cross-module lifecycle tests live under `test/integration/` and exercise Alchemy's engine with controlled API/process boundaries; they do not provision cloud resources. `test/integration/RealLocalBackend.test.ts` runs the pinned local backend: it downloads the release once into a cache under the OS temp directory, binds ports 3300-3399, and is skipped on Windows.

```sh
pnpm exec vitest run --project @confect/alchemy
```
