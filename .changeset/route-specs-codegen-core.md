---
"@confect/core": minor
---

`Guard` is in `@confect/core`: `Guard.make(name, middleware)`, `Guard.none` and `Guard.isGuard`. `Http.make` takes `guard`, the guard a backend's route specs run behind, and `Http.make({ guard: Guard.none })` declares a backend that serves only route specs. `api` and `handlers` go together and `docs` needs them; part of an api passed through an untyped value throws `Http.PartialApi`. `Http.routes(app, http, specs)` checks route specs with the backend's own endpoints, under `Http.Owner`'s new `route` kind, for a shared method and path and for a mount prefix. A manifest section's `GenerateInput.functions` carry each function's `visibility`, and its `VerifyInput` adds `functions` and `guard`, the name of the guard `confect/http.ts` declares.
