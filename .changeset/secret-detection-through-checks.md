---
"@confect/cli": patch
"@confect/test": patch
---

Fix secret detection for a `Schema.Redacted` or `Schema.RedactedFromValue` schema that carries a check, with or without `Schema.brand`. Previously such a secret, and a struct, array, union or optional key that held one, did not count as secret: `confect codegen` left the function or table out of `secrets` in `confect/_generated/testing`, and on the kernel target `TestConfect.layer` wrote its raw value to snapshots, failure reports and diffs. It is now marked as an unchecked secret is.

On the kernel target, a secret whose inner schema transforms, such as `Schema.RedactedFromValue(Schema.fromJsonString(...))`, is also marked where a union also has a member its stored value fits, such as `Schema.String`, with or without a check. Previously the kernel compared the stored value with the inner schema's decoded type, chose the other member and wrote the raw value to snapshots and failure reports.
