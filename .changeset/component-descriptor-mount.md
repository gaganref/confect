---
"@confect/core": minor
---

Add `Component.make(name, { env, client })`, a component's descriptor, and `Mount.make(component, { name, httpPrefix, env, options })`, a mount's client as a `Context.Reference` whose default is the component's client over that installation. `env` is typed from the descriptor's slots and `options` from its client constructor.
