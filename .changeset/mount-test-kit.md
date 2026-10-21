---
"@confect/core": minor
"@confect/cli": minor
"@confect/test": minor
---

`App.mount` takes a `testing` option that names a test kit by package specifier, such as `App.mount(aggregate, { testing: "<wrapper>/testing" })`. The generated `confect/_generated/testing` registry imports that module for the mount in place of the component package's `<package>/test` and calls its `register(t, name)`, which registers the mount and its nested components. Codegen still writes the HTTP prefixes of those nested components. A wrapper package's kit can then register children the official kit leaves out, and the host no longer replaces the registry entry by hand. Codegen fails, naming the mount, when the specifier is a relative path or does not resolve, or when the module's exports, read without running it, have no `register`. A CommonJS kit or one that re-exports another package with `export *` passes codegen, and `TestConfect.layer` names the mount if it has no `register`. Mounts without the option keep `<package>/test`.
