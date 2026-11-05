---
"@confect/cli": patch
---

Import each manifest section file before the impl in every registration file
and before the declared HTTP router, and render it again on incremental spec
edits. Remove a section file no section claims only after rewriting the files
that import it.
