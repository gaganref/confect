---
"@confect/core": major
"@confect/cli": major
---

Reject `app` and `docs` as mount names in `Mount.make` and `confect codegen`.

Rename mounts with either reserved name and update references to the mount name.

Before:

```ts
Mount.make(component, { name: "docs" });
```

After:

```ts
Mount.make(component, { name: "docsWorker" });
```
