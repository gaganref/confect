---
"@confect/server": minor
"@confect/test": minor
---

A backend can now refuse a push whose source its checks refuse, while Convex analyzes the push, so a deployment keeps serving the last source the checks passed. A check that only matters at deploy, such as one a manifest section's `verify` runs, no longer has to run as every function module loads, which Convex does on every call. Generated files do not change.

**This relies on `exportArgs`, which Convex marks `@internal`** (`server/registration.ts` in convex 1.49.0). Convex calls a registered function's `exportArgs` while it analyzes a push and never while it serves a call, but it does not promise to keep doing so. Pin Convex exactly, and rerun the push check contract test on each upgrade: `packages/server/test/local-backend/pushCheck.test.ts` in this repository.

Register a check at runtime with `PushCheck.register` from the new `@confect/server/PushCheck`, keyed by the default export of the backend's generated `_generated/schema` module, from a module every entry of the backend imports:

```ts
import * as PushCheck from "@confect/server/PushCheck";
import schema from "./_generated/schema";

PushCheck.register(
  schema,
  PushCheck.make("authz", () => door.refusals()),
);
```

The check returns its refusals as strings, each naming the declaration it refuses. Registering runs nothing. Every query, mutation and action Confect registers runs the checks registered for its backend's schema from its `exportArgs`, before it returns the validator. Each check runs at most once per check value in each loaded copy of `@confect/server`, through a module-scope memo, never one on `globalThis`, since Convex's Node executor keeps `globalThis` across pushes. Two backends that load one module graph share that verdict, and a component, whose schema is its own, has its own checks. A refusal throws `PushRefused`, whose message names the check, the function Convex was analyzing and each refusal. On the pinned local backend a refused push prints `Hit an error while pushing: Uncaught PushRefused: Push check "authz" refused the source while Convex analyzed list: …` for an isolate or component function and `Failed to analyze tasks/node.js: Push check …` for a `"use node"` action.

A group's raw Convex functions run the checks too, so a registration now returns a copy of each, with every own property of the original and its prototype, while the original stays unchanged. A frozen function works, and so does one another backend's group already guarded: its copy runs this backend's checks alone. `RegisteredConvexFunction.register` throws the tagged `InvalidPreparedDefinition`, naming the function when it can, for a definition whose push check metadata is present but malformed, rather than register it without its checks. The router `HttpRouter.make` builds runs the checks from its `getRoutes`. Convex discards a throw there, so a refusing router returns one route whose method is the refusal's message, which Convex prints inside its own `getRoutes()` error.

Convex analyzes each entry's own module graph, so an entry runs only the checks its graph registers. A backend with neither a function nor a router runs no check at a push.

`@confect/test` resolves a function through its `exportArgs`, so a refused source fails its first function call, but it serves HTTP without one. `Preflight.run(modules, { schema })` from `@confect/test` runs the checks a backend's modules register, apart from the memo, and fails with `PushRefused`, or with `NoPushEntry` when checks are registered for `schema` but no function or router of `modules` runs them. Run it once each time a test kit builds a backend.

The test kernel's isolate also no longer hides `queueMicrotask`, `setImmediate` or `MessageChannel` from Node's own modules, such as undici building a `Response` body, when convex-test's accessor for the global sits over the kernel's guard. That happened once a convex-test world had run in the same test runtime, and failed an HTTP handler that built a `Response` on Node versions whose undici schedules a microtask for it.
