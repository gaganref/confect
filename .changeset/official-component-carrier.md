---
"@confect/server": minor
---

Require an explicit carrier policy in `OfficialComponent.encodeCall`.

Before:

```ts
OfficialComponent.encodeCall(ref, args);
```

After:

```ts
OfficialComponent.encodeCall(ref, args, { carrier: "none" });
```

Use `none` to preserve the previous wire arguments when a component replays or
compares them. Use `forward` to include the caller's carrier for a reserving
mutation or action. Queries and non-reserving targets receive no carrier.
