---
"@confect/server": patch
---

End an instrumented root span with the outcome the client gets: a failure in a function with no error schema, other than a raw `ConvexError`, ends it as a defect, and so does an error encoding that dies with a `ConvexError`.
