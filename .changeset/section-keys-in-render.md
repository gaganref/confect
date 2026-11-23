---
"@confect/core": minor
"@confect/cli": minor
---

A generating manifest section's `render` now receives `sections`, the key of every section `App.make` declares, in declared order, its own key included. A section can write an import of another section's file only when that section is declared:

```ts
render: ({ sections }) => ({
  contents: sections.includes("tenancyRecord")
    ? 'import { tenancy } from "./tenancyRecord.js";\n'
    : "",
  errors: [],
}),
```

A component's sections get the keys its own `App.make` declares. `confect dev` renders again when `App.make` adds, removes or reorders a section. `sections` is not enumerable, so a section that serializes or spreads its input generates the same files as before. `sections` is a new required field of the `ManifestSection.GenerateInput` type, so a test that builds a `GenerateInput` by hand to call a section's `render` must add it; generated output does not change.
