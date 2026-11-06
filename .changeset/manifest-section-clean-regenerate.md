---
"@confect/cli": patch
---

Accept a declared HTTP router's import of a manifest section file when
codegen regenerates from an empty `confect/_generated`. Codegen now checks
Convex entrypoint ownership after it writes this run's section files.
