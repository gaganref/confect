---
"@confect/cli": patch
---

Codegen refuses a manifest section's description or summary that holds a `Date`,
a class instance with a `toJSON` method, or a symbol key, instead of writing what
`JSON.stringify` makes of it.
