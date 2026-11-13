---
"@confect/server": major
"@confect/cli": minor
---

`HttpRouter.make` now takes the generated database schema first: `HttpRouter.make(schema, routes, { api, observability })`. `HttpRouter.forSchema` and the schema-less `make` are removed.

To migrate:

- Run `confect codegen`. The generated `convex/http.ts` regenerates with the new call.
- Change hand-written calls. `HttpRouter.forSchema(schema)(routes, options)` becomes `HttpRouter.make(schema, routes, options)`. `HttpRouter.make(routes, options)` becomes `HttpRouter.make(schema, routes, options)` with the backend's generated schema, or `DatabaseSchema.make({})` for a router with no tables.
- `HttpRouter.Services` and `HttpRouter.Routes` now take the schema type: `HttpRouter.Services<typeof schema>`.
