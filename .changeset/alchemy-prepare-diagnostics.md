---
"@confect/alchemy": patch
---

When the code resource's `prepare` command fails, such as `confect codegen`, its `CommandError` now carries up to the last 8,192 characters of its stdout and stderr, redacted the same way as a failed push. A `prepare` command killed by a signal now fails with reason `exit` and names the signal, rather than reason `spawn`.
