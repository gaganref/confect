---
"@confect/core": minor
---

Remove `App.mount` and the record form of `App.make`'s `mounts`. Declare each mount with `Mount.make` and list it in `App.make({ components, mounts })`. `Auth.siteUrl` takes only a `Mount.make` mount.
