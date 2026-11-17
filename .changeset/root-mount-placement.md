---
"@confect/core": major
"@confect/cli": major
"@confect/alchemy": major
---

Move root mount settings from `Mount.make` to `Backend.mounts`. Root mounts hold placement only, and open slots become derived deployment variables such as `BULK_EMAIL_RESEND_API_KEY`.

### Breaking changes

- `App.make` refuses env bindings on a root app's mount.
- A required component slot may remain open. The deployment must supply it through the generated manifest's mount settings.

To migrate, remove `env` from root mounts, regenerate the backend, and pass the values through `Backend.mounts` by mount and slot name. In the same apply before the code push, the environment resource removes variables it introduced and no longer desires. The old code briefly runs without those variables. Names the resource never owned remain, and adopted names recover their original values. Plan a mount rename as a deployment. Components may still bind their own child's slots to constants or their own env entries.
