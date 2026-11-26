---
"@confect/cli": patch
"@confect/test": patch
---

Fix secret detection for a `Schema.Redacted` or `Schema.RedactedFromValue` schema that carries a check, with or without `Schema.brand`. Previously such a secret, and a struct, array, union or optional key that held one, did not count as secret: `confect codegen` left the function or table out of `secrets` in `confect/_generated/testing`, and on the kernel target `TestConfect.layer` wrote its raw value to snapshots, failure reports and diffs. It is now marked as an unchecked secret is.
