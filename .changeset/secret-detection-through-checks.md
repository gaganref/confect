---
"@confect/cli": patch
"@confect/test": patch
---

Fix secret detection for a `Schema.Redacted` or `Schema.RedactedFromValue` schema that carries a check, with or without `Schema.brand`. Previously such a secret, and a struct, array, union or optional key that held one, did not count as secret: `confect codegen` left the function or table out of `secrets` in `confect/_generated/testing`, and on the kernel target `TestConfect.layer` wrote its raw value to snapshots and failure reports. It is now marked as an unchecked secret is, except in the union case below.

A `Schema.RedactedFromValue` over a transformation, such as `Schema.RedactedFromValue(Schema.fromJsonString(...))`, in a `Schema.Union` beside a plain member its stored value also matches, such as `Schema.String`, is written unmarked to snapshots and failure reports. Without a check, or with a check when the transformed value holds no secret, it was unmarked before too. With a check and a secret inside the transformed value, such as `Schema.RedactedFromValue(Schema.fromJsonString(Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) }))).check(...)` in `Schema.Union([..., Schema.String])`, it was marked before and is not now. A later pull request reworks the redaction walk for this case.
