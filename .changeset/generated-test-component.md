---
"@confect/cli": minor
"@confect/test": minor
---

When a component can import `@confect/test`, codegen writes a `TestBackend` export built by the new `TestComponent.make`: its public functions, callback slots, laws, ports, mounts and settings, and `export`, `laws` and `callback` obligations, with no groups and no access or realm proof. A handle whose contract `confect/callbacks.ts` does not export stops codegen with `UndeclaredCallbackSlotError`. Its layer opens on the kernel as an app's does, gives a runtime without `withIdentity`, and answers each call to a slot's handle from a sink with a drawn return or a planned declared error. `TestComponent.exports` and `TestComponent.callbacks` take cases total over functions, slots and outcomes, and `TestBackend`'s app subject now carries `kind: "app"`.
