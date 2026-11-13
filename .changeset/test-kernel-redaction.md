---
"@confect/test": patch
---

The internal test kernel writes a value under a secret schema node, a `Schema.Redacted` or `Schema.RedactedFromValue` field, to its artifacts only as a marker: snapshot exports, failure reports, subscription diffs and read records. It reads the secret nodes from a Confect database schema's tables and from a secret policy that `TestConfect.layer` takes as `secrets`, keyed by component and function or table. The raw values stay in memory as replay state, and a restore given them puts them back. A failure report is a marked copy, and the raw error is never changed.
