---
"@confect/core": minor
"@confect/cli": minor
---

A manifest section can now give each function group a module of its own. Registered functions import each `.ts` section file that does not set `importedByFunctions: false`, so such a file that imports code only some groups need put that code in every function's bundle. Return `groups` from `render`, a function for each group by its spec file's path without `.spec.ts`, such as `tasks/assignment`, which each function's new `group` gives. Codegen calls each with `importPath`, which gives the specifier for an existing `.ts`, `.tsx` or `.mts` file relative to `confect/`, writes the string it returns to `_generated/sections/<file without .ts>/<group>.ts`, and imports it from that group's registration file alone.

Codegen records each module in `_generated/sectionFiles.json` and removes it once `render` stops returning it, unless it was edited. It reads and removes nothing in `_generated/sections` it did not record, and refuses to write a module over anything it did not write. `confect dev` rewrites the registration files of the groups that gain or lose a module. Codegen refuses `groups` that is not a plain object of functions, a group that registers no Convex function, a function that returns no string, an `importPath` of any other file or of one whose specifier another file also resolves from, and `groups` on a `.json` or `.md` file, even an empty one. A section that returns no `groups` generates the same files as before.
