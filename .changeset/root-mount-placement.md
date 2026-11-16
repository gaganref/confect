---
"@confect/core": major
"@confect/cli": major
"@confect/alchemy": minor
---

Move root mount settings from `Mount.make` to `Backend.mounts`. Root mounts hold placement only, and open slots become derived deployment variables such as `BULK_EMAIL_RESEND_API_KEY`.

### Breaking changes

- `App.make` refuses env bindings on a root app's mount.
- A required component slot may remain open. The deployment must supply it through the generated manifest's mount settings.

To migrate, remove `env` from root mounts, regenerate the backend, and pass the values through `Backend.mounts` by mount and slot name. Components may still bind their own child's slots to constants or their own env entries.
