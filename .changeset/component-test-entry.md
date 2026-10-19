---
"@confect/cli": patch
"@confect/test": minor
---

The generated `confect/_generated/testing` registry registers a component mounted from another package through that package's `<package>/test` export, calling its `register(t, name)` as Convex components such as `@convex-dev/workpool/test` do. It no longer writes paths into another package's files or the package manager's store, so the committed file is the same on every machine. Codegen fails with the package name when the `/test` export is missing. Components in your own package keep their relative schema and module imports.

`TestConfect.ComponentKit` is either a component's schema and modules or an object with that `register` function, and `TestConfect.layer` accepts both in a registry.
