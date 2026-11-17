---
"@confect/core": major
"@confect/cli": major
---

Reserve `app` and `docs` as mount names for the root app and docs page.

A standalone `Mount.make` call rejects either reserved literal at compile time.
Calls written inline in `App.make`, typed as `Mount.Any`, or placed in a
`ReadonlyArray<Mount.Any>` literal widen the name to `string` and compile.
`confect codegen` rejects either reserved name in these forms and when supplied
as a widened `string`, with the message that the name is reserved for the root
app or docs page.

The rule deliberately applies to every mount, including a component's child
mounts. Names are case-sensitive, so `App` and `DOCS` are accepted.

To migrate, rename mounts with either reserved name and update references to the mount name.
A wrapper that passes a generic name must cast it or pass a literal, even when
its constraint excludes the reserved names.

Before:

```ts
Mount.make(component, { name: "docs" });
```

After:

```ts
Mount.make(component, { name: "docsWorker" });
```
