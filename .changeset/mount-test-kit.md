---
"@confect/core": minor
"@confect/cli": minor
---

`App.mount` takes a `testing` option that names a test kit by package specifier, such as `App.mount(aggregate, { testing: "<wrapper>/testing" })`. The generated `confect/_generated/testing` registry imports that module for the mount in place of the component package's `<package>/test` and calls its `register(t, name)`, which registers the mount and its nested components. A wrapper package's kit can then register children the official kit leaves out, and the host no longer replaces the registry entry by hand. Codegen fails, naming the mount, when the specifier is a relative path, does not resolve, or names a module without a `register` export. Mounts without the option keep `<package>/test`.
