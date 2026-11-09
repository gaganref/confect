---
"@confect/core": minor
"@confect/cli": minor
---

A declared component's codegen runs each manifest section's `generate`, and
its registration files import the section file. `render` receives `target`,
`{ kind: "app" }` or `{ kind: "component", name }`, and `confectDirectory`, the
absolute path of `confect/`.
