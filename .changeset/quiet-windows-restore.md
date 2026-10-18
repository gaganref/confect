---
"@confect/cli": patch
---

Fix `confect dev` recovery on Windows after a component rejects a Node.js function group. Release the generated directory's watcher before restoring the previous output, and retry briefly if another tool temporarily locks the directory.
