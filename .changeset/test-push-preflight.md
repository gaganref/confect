---
"@confect/server": patch
"@confect/test": minor
---

**Test backends now refuse a source whose push checks refuse it.** This changes the behaviour of existing test suites. A layer that built before may now die while it builds, and the test then fails before its first call.

`TestConfect.layer`, on the convex-test and kernel targets, and the `layer` of a generated `TestBackend` or component subject, now run the push checks that `PushCheck.register` registered for the app's schema and for each component a kit registers. They run once per build, before the layer serves any call. A refused source therefore never serves a call. That includes a test whose first call is an HTTP request, which runs no function's `exportArgs` and so used to reach a refused source. A generated subject runs the checks after every module loads and before any mount's `init` or `seed`. A component the test registers later with `registerComponent` runs its checks as it registers. A backend with no registered check builds and serves as before.

A refusal is a defect of the backend under test, as a refused push is of a deployment. So building dies with `PushRefused`, which names the check and each refusal. It also dies with `NoPushEntry` when checks are registered for the app's schema, or a component's, but none of its functions or routers runs them, since no push would run them either. The layers' types do not change.

A mounted component's router is now built while the layer builds, and its first HTTP request reuses that router, so a router that is a component's only checked entry is checked too. It reads its mount's site URL as `CONVEX_SITE_URL` without the host's environment changing, so backends built at once each get their own. On the kernel it loads under the component's environment, the isolate's guards and the backend's seeded random stream, as the component's modules do, so its load draws the same values on every run with one seed. It used to load inside the bridge's first request, so a router that draws while it loads now draws other values than before.

A component's schemas are found from its own modules: each schema a module registers checks for as it loads, or as a module it imports first does, belongs to that component, and stays with the module once it is cached. Every component is checked this way, generated and packaged kits included, and no generated file changes. For a kit whose modules were evaluated outside any layer, `registerComponent` and a kit's `{ schema, modules }` take an optional `databaseSchema`.

A test that builds a refused source on purpose, such as one that asserts a call's own refusal, passes `pushChecks: "skip"` to the layer:

```ts
TestConfect.layer(schema, convexSchema, modules, { pushChecks: "skip" });
```

These runs are apart from the memo Convex's analysis uses, so a test that builds several backends over one module graph runs the checks once for each build. To find the checks, a build evaluates the backend's modules before the first call rather than at it. The kernel loads them under its own rules, and its open reuses that load. The convex-test target imports each module a deployment would register as a function. A module that fails to load, whether its loader rejects or throws, still fails only the call that loads it, as before. `Preflight.run` is now only for a backend built another way, such as `convexTest` directly.

`PushCheck.register` in `@confect/server` now also tells the observers in the set under `Symbol.for("@confect/server/PushCheck/observers/v1")` of each schema it registers a check for, which is how `@confect/test` traces a component's checks.
