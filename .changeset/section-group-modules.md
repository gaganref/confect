---
"@confect/core": minor
"@confect/cli": minor
---

A manifest section can now give each function group a module of its own. Registered functions import each `.ts` section file that does not set `importedByFunctions: false`, so such a file that imports code only some groups need put that code in every function's bundle. Return `groups` from `render`, a function for each group by its spec file's path without `.spec.ts`, such as `tasks/assignment`, which each function's new `group` gives. Codegen calls each with `importPath`, which gives the `.js` specifier for an existing `.ts` file relative to `confect/`, writes the string it returns to `_generated/sections/<file without .ts>/<group>.ts`, and imports it from that group's registration file alone.

Codegen records each module in `_generated/sectionFiles.json` once it has written it, and removes it once `render` stops returning it, unless it was edited. It removes no file in `_generated/sections` it did not record, though it removes a directory there that it leaves empty, and writes a module where it recorded none only over nothing or over a file that already holds the same bytes. `confect dev` now writes every group's registration file, as a full run does. Codegen refuses `groups` that is not a plain object of functions, a group that registers no Convex function, a function that returns no string, an `importPath` of anything but a `.ts` file outside `_generated`, or of one beside a `.js` file of the same name, and `groups` on a `.json` or `.md` file, even an empty one.

Each entry of `functions` in `render`'s and `verify`'s input now has a required, non-enumerable `group`. A `ManifestSection.GenerateInput` built by hand, such as in a test of a section's `render`, must add it, or TypeScript reports it missing. For a section that returns no `groups`, codegen writes no file under `_generated/sections` and no group entry in `sectionFiles.json`; `Object.getOwnPropertyNames` on a function now also lists `group`.

A fork build before this one refuses a `sectionFiles.json` that lists a group module. To go back to one, delete `_generated/sectionFiles.json` first. The earlier build then generates as long as no section's `render` reads `group` or returns `groups`, since it provides neither, and you can remove the modules left under `_generated/sections` by hand.
