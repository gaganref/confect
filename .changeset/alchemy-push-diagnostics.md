---
"@confect/alchemy": patch
---

Include up to the last 8,192 characters of stdout and stderr in failed code pushes. Strip ANSI escapes and replace the deploy key or self-hosted admin key, their URL-encoded and base64 forms, and Convex key-shaped values with `<REDACTED>`. Match credentials only at eight or more characters to preserve ordinary diagnostics. Stop draining inherited pipes one second after the CLI exits.
