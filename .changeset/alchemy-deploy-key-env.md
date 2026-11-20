---
"@confect/alchemy": patch
---

Code pushes no longer write the deploy key, or a local backend's admin key, to a temporary file. `convex deploy` receives the key only in its environment, so a push killed with `SIGKILL` leaves no key on disk. A project's `.env.local` and `.env` still cannot redirect the push: the push sets the CLI's other deployment and credential variables to empty values, and the Convex CLI never fills a variable that is already set from those files. A failed health check's answer and a failed mount init's mount and detail replace the key, and its encoded forms, with `<REDACTED>`.
