---
"@confect/core": minor
"@confect/cli": minor
---

`Component.make` takes `testing`, the package specifier of the component's test kit. Codegen imports it for each mount of the descriptor from another package before searching `<package>/testing` and `<package>/test`, and refuses a named kit that is a path, does not resolve or exports no `register`.
