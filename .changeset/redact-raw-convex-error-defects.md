---
"@confect/core": patch
"@confect/server": patch
---

Wrap raw ConvexError defects in plain errors so Convex redacts their data in production. Preserve the exact InvalidCursor pagination control data from QueryStream and Convex native pagination, using a shared core predicate that rejects extra fields.
