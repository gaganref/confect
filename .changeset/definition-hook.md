---
"@confect/server": minor
---

A library can now change each Convex function definition Confect registers, before Convex sees it. `RegisteredConvexFunction.bindDefinitionHook(hook)` binds a hook that receives the function's visibility, `"public"` or `"internal"`, and its Convex definition, `{ args, returns, handler }`, and returns the definition Convex registers in its place. It sees every query, mutation and action `RegisteredConvexFunction.register` registers from a prepared definition, generated registrations included, and every Node action `RegisteredNodeFunction` registers. It never sees a raw Convex function a group carries. Push checks still run. With no hook bound, every definition registers unchanged.

A hook binds once, before any function registers. A second bind, of any hook, throws `DefinitionHookRefused` with reason `AlreadyBound`, and a bind after a function registered throws it with reason `FunctionRegistered`, since that function registered without the hook. Bind it from a manifest section file that sets `importedFirst`, which every registration imports first. The definition's `args` and `returns` are lazy getters, and reading either compiles the function's schemas, so a hook that changes them should define its own as getters.
