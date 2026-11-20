---
"@confect/core": minor
"@confect/server": minor
"@confect/cli": minor
"@confect/test": minor
---

A manifest section can now refuse a push whose source its checks refuse, while Convex analyzes the push, so a deployment keeps serving the last source the checks passed. A check that only matters at deploy, such as the one a section's `verify` runs, no longer has to run as every function module loads, which Convex does on every call.

**This relies on `exportArgs`, which Convex marks `@internal`** (`server/registration.ts` in convex 1.49.0). Convex calls a registered function's `exportArgs` while it analyzes a push and never while it serves a call, but it does not promise to keep doing so. Pin Convex exactly, and rerun the push check contract test on each upgrade: `packages/server/test/local-backend/pushCheck.test.ts` in this repository.

Set `pushCheck: true` on a section's `generate` and export `pushCheck` from its `.ts` file, made at module scope with `PushCheck.make` from the new `@confect/server/PushCheck`:

```ts
import * as PushCheck from "@confect/server/PushCheck";
import door from "../door";

export const pushCheck = PushCheck.make("authz", () => door.refusals());
```

The check returns its refusals as strings, each naming the declaration it refuses. Every generated registration that imports the file wraps its group's queries, mutations and actions with `PushCheck.guardFunctions`, so each function's `exportArgs` runs the checks before it returns the validator. Each check runs at most once per evaluated module graph, through a module-scope memo, never one on `globalThis`, since Convex's Node executor keeps `globalThis` across pushes. A refusal throws `PushRefused`, whose message names the check, the function Convex was analyzing and each refusal. On the pinned local backend a refused push prints `Hit an error while pushing: Uncaught PushRefused: Push check "authz" refused the source while Convex analyzed tasks/list:list: …` for an isolate or component function and `Failed to analyze tasks/node.js: Push check …` for a `"use node"` action.

The HTTP router runs a check from its `getRoutes`, through `PushCheck.guardRouter`, only when no registered function runs it: for a section with `importedByFunctions: false`, or a backend whose only entry is its router. Convex refuses that push too, but discards the refusal and prints a generic `getRoutes()` error, so put a check where a function runs it when you can. A backend with neither a function nor a router runs no check at a push.

`@confect/test` resolves a function through its `exportArgs`, so a refused source fails its first function call, but it serves HTTP without one. `Preflight.run(modules)` from `@confect/test` runs the push checks a backend's modules carry, apart from the memo, and fails with `PushRefused`. Run it once each time a test kit builds a backend.

Codegen refuses `pushCheck` on a `.json` or `.md` file. A file that declares one carries the header line `// The entries that import this file run its pushCheck when Convex analyzes a push.`, so `confect dev` rewrites every registration file when a section starts or stops declaring one. A backend with no such section generates the same files as before.
