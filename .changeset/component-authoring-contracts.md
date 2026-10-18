---
"@confect/core": minor
"@confect/cli": minor
---

Preserve `Schema.Struct` field maps and decoded ID-free class types when you reuse component codecs with `Component.schema`, and add `Ref.Callable<typeof ref>` so a shared handler can accept both a component's public ref and its bound internal ref while retaining args, returns, and errors. Function references with concrete argument types now reject assignments that would omit required arguments. Generated component `Id` factories accept `_storage` and `_scheduled_functions` with the component's scope while `TableNames` lists only user tables.
