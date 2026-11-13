---
"@confect/core": major
"@confect/server": major
---

Errors that were `Data.TaggedError` classes are now `Schema.TaggedError` classes with a brand. Each keeps its tag, its fields and its message.

- In `@confect/core`: `Component.EmptyComponentScopeError`, `Component.ComponentNameCollisionError`, `Component.UninstalledComponentReferenceError`, `Http.RouteUnderMountPrefix`, `Http.DuplicateRoute`, `Http.OverlappingMountPrefixes`, `SchemaToValidator.ReservedArgumentCollision` and `Table.GroupFieldError`.
- In `@confect/server`: `ActionCall.ActionCallAlreadyUsed`, `ActionCall.ActionCallNotUsed`, `ActionCall.MissingFunctionType`, `ActionCall.NestedActionNotAllowed`, `ActionCall.SchedulingNotAllowed`, `DatabaseSchema.EmptyDatabaseScopeError`, `DatabaseSchema.TableBindingMismatchError`, `GroupImpl.MissingRequiredMiddlewareError` and `QueryStream.DeferredStreamMismatchError`.

To migrate:

- Build these errors with `Error.make(fields)`, or `Error.make({})` for one with no fields. `new Error(fields)` still works, but now checks its fields.
- A structurally equal object no longer type-checks as one of these errors.
