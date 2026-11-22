# Local Convex backend test support

`confect-local-backend` is a private workspace package shared by the JavaScript
client and server integration suites. It owns backend startup and shutdown,
readiness checks, fixture codegen, and Vitest configuration. The tests stay in
`packages/<package>/test/local-backend/`.

Use Node 24, as pinned in the root `.node-version`. The fixture includes Node
actions that the local backend cannot deploy under Node 26.

From the repository root:

```sh
pnpm build
pnpm test:js:local-backend
pnpm test:server:local-backend
```

Run these suites sequentially: they use the same fixture deployment and ports
3210 and 3211. Stop the example backend before running them. The first run may
download a Convex backend binary. Each suite manages its own backend lifetime;
sharing this package does not share a running process between test invocations.

## Use the harness

Add `confect-local-backend` as a workspace devDependency. A package's
`vitest.local-backend.config.ts` supplies its root, name, and the workspace's
base configuration:

```ts
import { defineLocalBackendConfig } from "confect-local-backend/vitest";
import sharedConfig from "../../vitest.shared";

export default defineLocalBackendConfig({
  base: sharedConfig,
  root: import.meta.dirname,
  name: "@confect/js",
});
```

Tests import the scoped backend from `confect-local-backend/LocalBackend` and,
when needed, generated function refs from `confect-local-backend/refs`.
The backend layer provides a Convex HTTP client for accessing the deployment.
The client suites use its URL to construct the public HTTP and WebSocket client
layers.

## Maintain the fixtures

The shared Convex application lives in `fixtures/`. Its own private workspace
package declares the CLI and backend dependencies. Keeping those dependencies
separate from the harness avoids a workspace cycle through `@confect/server`.

`fixtures/family` is a second Confect app whose `auth.ts` declares a provider
family, for the provider family suite. Its own backend reads `PEER_SERVICES`,
which the suite changes without pushing again.

After changing fixture functions, regenerate the checked-in outputs:

```sh
pnpm codegen:local-backend
```

Test global setup runs Confect codegen automatically. The explicit codegen
command also regenerates Convex's API declarations. Each component's
`convex/_generated/` is git-ignored, so the command copies Convex's
`ComponentApi` for each component to `fixtures/convexComponentApi/_generated/`.
The server's parity test compares those copies with `Component.Api`. CI checks
that the shared fixture output, copies included, matches what is committed, and
does the same for the server's separate mock-backend fixture output.

`setupForFixture` is also exported for the server's mock-backend setup. It runs
the repository CLI shim, which requires a prior build, without giving the
harness a dependency on the CLI package.

## Commands that need no backend

The root `pnpm test` starts a local backend, because the `@confect/test`
project's global setup runs `seedAuth`. These commands need none: `pnpm build`,
`pnpm check`, `pnpm typecheck`, `bun test ./scripts`,
`vitest run --project <name>` for every project except `@confect/test`, and
`pnpm test:server:mock-backend`. `pnpm test:server:local-backend`,
`pnpm test:js:local-backend`, `pnpm codegen:local-backend` and the
`@confect/test` project each start one.
