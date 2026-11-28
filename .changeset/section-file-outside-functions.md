---
"@confect/core": minor
"@confect/cli": minor
---

A manifest section can now keep the file it generates out of registered functions. Codegen imports every section's file into each registered function as a side effect, so a file that pulls in a large dependency, such as an app's HTTP entry, added that weight to every function's bundle. Set `importedByFunctions: false` on the section's `generate` and no registered function imports its file. The default is `true`, and a backend with no such section generates the same files as before.

Codegen still writes, verifies and claims the file. The HTTP router and, when `wrapsCrons` is set, `convex/crons.ts` import it as they do any section file. A file that opts out carries a second header line, `// Registered functions do not import this file.`, so `confect dev` can tell when a section starts or stops opting out and rewrites every registration file, as a full run does.
