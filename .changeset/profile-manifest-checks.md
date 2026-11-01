---
"@confect/core": minor
"@confect/cli": minor
---

Check manifest sections against previous data, print every note and deduplicate errors at the declaring spec, remove only section-failed manifests and note vanished sections. Unreadable previous manifests supply no sections. Preserve section history across unrelated failures and skip unchanged manifest writes. Treat unusable previous exports as empty history.
