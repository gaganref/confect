---
"@confect/cli": minor
---

Codegen checks and catalogues route specs. It refuses them without a `confect/http.ts` whose `guard` is a `Guard`, in a backend without `confect/app.ts`, on an endpoint's method and path or under a mount prefix, and with a path parameter, or a GET or OPTIONS arg, that does not encode as a string or, in a query, an array of strings. Each route spec joins the manifest's `http.app` catalogue by module path and name. A leaf of route specs alone gets no `convex/` module and no registration module, where before its module exported each route as `undefined`. A section's `render` and `verify` get each function's `visibility`, `verify` gets the declared guard's name, and `testing` no longer gets route descriptions. A backend without route specs gets the same generated files.
