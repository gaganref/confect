---
"@confect/core": minor
"@confect/server": minor
---

Add `CommitTs`, a table field schema that compiles to Convex's `v.commitTs()`. Its type is `bigint | CommitTsPlaceholder`, as in Convex. Add `vars.commitTs` to the database writer so a mutation can store its commit timestamp. Plain `Schema.BigInt` fields still compile to `v.int64()`.
