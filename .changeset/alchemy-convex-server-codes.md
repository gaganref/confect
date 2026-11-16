---
"@confect/alchemy": patch
---

Preserve a validated Convex server error identifier in `serverCode` alongside the existing HTTP error classification, and include the operation, status and code in error messages without response body text. Server identifiers contain at most 64 alphanumeric characters and start with a letter. Error bodies larger than 8 KiB supply no server code.
