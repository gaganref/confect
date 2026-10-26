---
"@confect/server": minor
---

Default QueryStream.paginate and QueryStream.collect to a 2,000-row budget per run. At the limit, one extra counted row may be read to detect an overrun without emitting it. Explicit limits override this default.
