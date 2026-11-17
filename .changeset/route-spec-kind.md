---
"@confect/core": minor
"@confect/server": patch
"@confect/cli": patch
---

`FunctionSpec.httpAction({ name, method, path, args, returns, error })` declares a route: an action served at `method` and `path` instead of registered with Convex. Its `functionVisibility` is `"http"`, and `FunctionSpec.FunctionVisibility` is now Confect's `"public" | "internal" | "http"`, so middleware sees `"http"` in a route's invocation. `spec.route` holds the method, the path and its `:name` parameters. The maker refuses a method Convex does not route, a wildcard, a regex, an optional or partial-segment parameter, an empty segment and a repeated parameter, and a parameter that names no argument is refused at the path and when the args are first read. A route has no `headers` slot. A profile's `httpAction` builder keeps its fields and middleware but not its reserved argument. A route is in neither `refs.public` nor `refs.internal`, no component exports it, `Ref.make` refuses it, and a Node group refuses it. The server's definition builders and the generated registration module register no Convex function for it.
