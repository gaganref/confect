---
"@confect/cli": patch
---

Codegen refuses two listed component definitions that share a `defineComponent` name, naming both imports, instead of pairing each mount with whichever was listed last.
