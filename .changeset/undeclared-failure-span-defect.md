---
"@confect/server": patch
---

End an instrumented root span as a defect when a function with no error schema fails with anything but a raw `ConvexError`, so a tracer sees the outcome the client gets.
