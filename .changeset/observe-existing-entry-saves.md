---
"@confect/cli": patch
---

Avoid repeated generation after repairing a source file in dev mode when its structural notification arrives before the dependency watcher observes the edit.
