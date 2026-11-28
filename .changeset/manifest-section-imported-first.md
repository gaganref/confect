---
"@confect/core": minor
"@confect/cli": minor
---

A manifest section can now ask for its file to load before any other module. Set `importedFirst: true` on the section's `generate`, and every registration file and `convex/http.ts` import that file first, ahead of the other section files, so its module-load code runs before any function registers. The file carries a second header line, `// Registered functions import this file first.`, so `confect dev` rewrites every registration file when a section starts or stops setting the option, as a full run does. At most one section may set it, and codegen refuses it on a `.json` or `.md` file and with `importedByFunctions: false`. Without the option, the import order is the same as before.
