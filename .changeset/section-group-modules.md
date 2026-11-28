---
"@confect/core": minor
"@confect/cli": minor
---

A manifest section can now give each function group a module of its own. Every registered function imports each section's file, so a file that imports code only some groups need put that code in every function's bundle. Return `groups` from `render`, a function for each group by its spec file's path without `.spec.ts`, such as `tasks/assignment`. Codegen calls each with `importPath`, which gives the specifier for a `.ts`, `.tsx` or `.mts` file in `confect/`, writes the string it returns to `_generated/sections/<file without .ts>/<group>.ts`, and imports it from that group's registration file alone.

Codegen removes a group's module once `render` stops returning it, and `confect dev` rewrites the registration files when the set of modules changes. It refuses a group that registers no Convex function, a function that returns no string, an `importPath` of any other file, and `groups` on a `.json` or `.md` file, even an empty one. A section that returns no `groups` generates the same files as before.
