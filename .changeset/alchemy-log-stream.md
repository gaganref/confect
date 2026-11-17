---
"@confect/alchemy": minor
---

Add `Convex.LogStream` to manage Axiom, Sentry, and webhook log streams with redacted credentials and credential URLs, in-place updates, owned removal despite drift, and explicit errors for drift or lost ownership.

Retry interrupted updates without losing ownership, accept Convex-normalized URLs and topics, and refuse webhook URLs with unredacted usernames or passwords before stream API access.
