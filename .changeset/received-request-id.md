---
"@confect/server": major
---

Breaking change. `RegisteredFunction.ReceivedValue`'s `requestId` is now `string | undefined`. Convex gives a query no request metadata, so a query that reserves an argument receives no request ID. A function whose runtime rejects the request-metadata read now receives `undefined` too, where before the call failed. Mutations and actions on Convex still receive a string at run time.

Who is affected: code that reads `RegisteredFunction.Received`'s `requestId` and treats it as a `string`, such as passing it where a `string` is expected or returning it through a `Schema.String` field. Code that reads only `value`, `deployment` or `visibility` is unaffected.

The compile error looks like this:

```
error TS2322: Type 'string | undefined' is not assignable to type 'string'.
```

To migrate, handle the missing ID where you read it. For example, `const requestId = received.requestId ?? "none";`, or refuse it with `if (received.requestId === undefined) return yield* Effect.die("no request ID");`. To expose a missing ID in a Convex return field, use `Schema.NullOr(Schema.String)` and return `received.requestId ?? null`.
