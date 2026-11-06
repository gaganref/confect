---
"@confect/cli": patch
---

Codegen refuses a manifest section's description or summary that holds a `Date`,
a class instance or array with a `toJSON` method, a getter, a non-enumerable
property, or a symbol key, instead of writing what `JSON.stringify` makes of it.
