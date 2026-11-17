---
"@confect/core": major
"@confect/cli": major
---

Replace `manifest.http.mounts` with an HTTP endpoint catalogue keyed by owner, group, and endpoint. Every leaf includes `method`, `path`, `owner`, `group`, `endpoint`, and the manifest `digest`. Prefixed mounts include routes from nested packaged components, and route edits change the digest.

To migrate, read mount prefixes from `manifest.mounts[name].httpPrefix` and endpoint addresses from `manifest.http[owner][group][endpoint].path`. `Manifest.RouteOf<typeof manifest>` types the endpoint leaves.
