---
"@confect/server": minor
---

Add QueryStream.collect, which returns the complete stream or fails when its read budget stops consumption.

At either the row or byte limit, one extra row may be read to distinguish completion from an overrun. It counts toward reported reads but is never emitted. Exact limits succeed on completion, including zero for an empty stream. Pagination follows the same rule.
