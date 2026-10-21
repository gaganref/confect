---
"@confect/server": minor
---

Add `OfficialComponent` for calling an official Convex component's client from Confect handlers. `OfficialComponent.make(name, client)` returns a function that calls any of the client's promise methods without a ctx, typed with the `QueryRunner`, `MutationRunner` or `ActionRunner` each method needs. A rejected call dies with `ComponentCallFailed`. `encodeCall` and `encodeField` encode a ref's arguments through its codecs for methods that take a function reference and its arguments.
