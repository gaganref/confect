---
"@confect/server": patch
---

Wrap raw ConvexError defects in plain errors so Convex redacts their data in production. Preserve only the exact InvalidCursor pagination control signal.
