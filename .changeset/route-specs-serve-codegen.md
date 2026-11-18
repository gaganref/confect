---
"@confect/cli": minor
---

Codegen serves route specs. A backend with route specs gets `confect/_generated/routes.ts`, which passes each leaf that declares one to `Routes.make`, a `convex/http.ts` that serves `confect/http.ts`'s endpoints and the route specs together through `http.ts`'s `guard`, and `confect/_generated/openapi.json`, the OpenAPI document of the route specs alone. A route error without an `HttpApiSchema.status` fails codegen at the spec that declares the route, naming the route and the error. Removing the last route spec removes both files and restores the router a backend without route specs gets. An incremental run writes these files as a full run does. A component serves its route specs under each mount's HTTP prefix. A backend without route specs gets the same generated files as before.
