---
"@confect/core": patch
"@confect/server": patch
"@confect/test": patch
---

A function's arguments or return that hold a secret, a `Schema.Redacted` that `Schema.RedactedFromValue` decodes to, no longer register a Convex validator. Convex's validator prints the whole value it refuses, so a malformed call echoed its secret, and a return it refused, such as one holding an ID from the wrong table, printed the secret to the caller, to the function log and to log streams. Confect now checks that side in the handler against the validator Convex would have run, arguments before the handler and the return after it, and tests each ID's table with `db.normalizeId`. A refusal reads `ArgumentValidationError` or `ReturnsValidationError` with the path, as Convex's does, and never the value. A side with no secret keeps its Convex validator.

Registration refuses an action whose secret side holds an ID, since an action has no database to check an ID's table, and any secret side that holds a function handle, whose format only the backend parses. A definition hook now reads `undefined` for a side that holds a secret.

`@confect/core/ValidatorCheck` exports the check, the port of the backend's `Validator::check_value_internal` that the test kernel already used for sinks, so the kernel and the server share one.
