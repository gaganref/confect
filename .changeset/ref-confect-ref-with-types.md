---
"@confect/core": patch
---

`Ref.ConfectRefWithTypes` is exported. A type that contains a mapped ref, such as a generated `testing.ts`'s `TestBackend` or a component descriptor that names an `init` ref, is printed by this name, and `tsc` with `declaration: true` failed with TS4023 or TS4082 when the compiler had no name for it. It is the shape `Ref.ConfectRef` already is, so no signature changes.
