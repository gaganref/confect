---
"@confect/test": patch
---

The internal test kernel writes a value under a secret schema node, a `Schema.Redacted` or `Schema.RedactedFromValue` field, to its artifacts only as a marker: snapshot exports, failure reports and subscription diffs. It reads the secret nodes from a Confect database schema's tables and from declared argument and return schemas. `TestConfect.layer` with `target: "kernel"` passes the app's table schemas. The raw values stay in memory as replay state, and a restore given them puts them back.
