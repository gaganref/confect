---
"@confect/core": minor
"@confect/cli": minor
"@confect/test": minor
---

`App.make({ env, components, mounts })` takes the `convex.config` definitions a backend mounts and its `Mount.make` mounts as lists. Codegen writes one `app.use` per mount, in list order, with the definition whose `defineComponent` name is the mount's component name. It refuses a mount without a listed definition, a listed definition without a mount, and two mounts with one name.
