---
"@confect/core": minor
"@confect/server": minor
---

A query can now reserve an argument when its own builder names one, as in `FunctionSpec.internalQuery({ name: "read", reservedArgument: "context", returns: () => Schema.String })`. Registration accepts any optional value under that name and removes it before decoding, as it does for mutations and actions. `RegisteredFunction.Forward`'s value now reaches such a query through `QueryRunner`, `QueryTransactionContext` and `MutationTransactionContext`. A forwarded value is part of the query's arguments, and so of its cache key. A profile's query and paginated query builders still reserve nothing, and a query that names no reserved argument is unchanged.

`RegisteredFunction.ReceivedValue`'s `requestId` is now `string | undefined`. Convex gives a query no request metadata, so a reserving query receives no request ID, and neither does a function whose runtime rejects the request-metadata read, which before failed the call. Mutations and actions on Convex still receive a string. Code that reads `requestId` as a `string` must now handle `undefined`.
