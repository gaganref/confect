---
"@confect/server": patch
---

Document and test how ConvexError defects reach the client. Declared errors are schema-encoded as ConvexError data. ConvexError defects pass through bare with their data intact so pagination, Workpool and other Convex integrations keep their control signals. Other defects reject as plain errors that Convex redacts in production.
