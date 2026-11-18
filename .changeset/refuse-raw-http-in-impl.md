---
"@confect/cli": patch
---

Refuse a Convex function registered in an impl whose handler is not exactly a query, mutation or action, such as a raw HTTP action. Convex skips such an export at push, so it never deployed and never failed. The error says to declare a route spec instead.
