---
"@confect/core": minor
"@confect/cli": minor
---

Add format 1 component manifests to `confect codegen --component-dir`. Ship the generated manifest through `Component.make(name, { manifest, client })` so hosts type mount settings from it. Components and hosts must use matching manifest formats.
