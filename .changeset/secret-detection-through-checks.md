---
"@confect/cli": patch
"@confect/test": patch
---

Fix secret detection for a `Schema.Redacted` or `Schema.RedactedFromValue` schema that carries a check, with or without `Schema.brand`. Previously such a secret, and a struct, array, union or optional key that held one, did not count as secret: `confect codegen` left the function or table out of `secrets` in `confect/_generated/testing`, and on the kernel target `TestConfect.layer` wrote its raw value to snapshots, failure reports and diffs. It is now marked as an unchecked secret is.

On the kernel target, a secret in a union, or beneath a schema that stores its value in another form, is now marked wherever the stored value could have come from it. Previously the kernel chose a union's members by comparing the stored value with each member's decoded shape and walked only the members it chose, one after another. A renamed key (`Schema.encodeKeys`), a struct stored as a JSON string, a flipped schema or a secret `-0` could then reach snapshots and failure reports raw, and a snapshot could hold a marker inside a marked value, which its own restore refused. The kernel now rules out a member only when the member's encoded form cannot hold the stored value, marks what every other member would mark, and marks a value whole beneath a node it cannot follow, such as one with an encoding. This can mark more than before: a struct with renamed keys that holds a secret, or a `Schema.OptionFromNullOr` of such a struct, is marked whole.
