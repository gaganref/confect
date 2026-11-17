---
"@confect/alchemy": patch
---

Include up to the last 8,192 characters of stdout and stderr in failed code pushes. Strip ANSI escapes and replace the deploy key or self-hosted admin key, their percent-encoded, base64 and base64url forms, and Convex key-shaped values with `<REDACTED>`. Match credentials only at eight or more characters to preserve ordinary diagnostics. Retain redacted diagnostics and name the signal when the CLI dies on a signal. Stop draining inherited pipes one second after the CLI exits.
