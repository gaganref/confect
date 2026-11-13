---
"@confect/cli": minor
"@confect/test": minor
---

When a component can import `@confect/test`, codegen writes a `TestBackend` export built by the new `TestComponent.make`: its public functions, callback slots, its own `init` from its descriptor, laws, ports, mounts and settings, and `export`, `laws` and `callback` obligations, with no groups and no access or realm proof. A handle whose contract `confect/callbacks.ts` does not export stops codegen with `UndeclaredCallbackSlotError`. Its layer opens on the kernel as an app's does, after running the component's own `init` with typed `install` args. It gives a runtime without `withIdentity`, and holds each call to a slot's handle, scheduled ones included, as a pending command the test answers with a drawn return or a declared error. `TestComponent.exports` and `TestComponent.callbacks` take cases total over functions, slots and outcomes, and `TestBackend`'s app subject now carries `kind: "app"`.
