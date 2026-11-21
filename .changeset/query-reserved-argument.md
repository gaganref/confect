---
"@confect/core": minor
"@confect/server": minor
---

A query can now reserve an argument when its own builder names one, as in `FunctionSpec.internalQuery({ name: "read", reservedArgument: "context", returns: () => Schema.String })`. Registration accepts any optional value under that name and removes it before decoding, as it does for mutations and actions. `RegisteredFunction.Forward`'s value now reaches such a query through `QueryRunner`, `QueryTransactionContext` and `MutationTransactionContext`, and `OfficialComponent.encodeCall` with `{ carrier: "forward" }` forwards to it. A forwarded value is part of the query's arguments, and so of its cache key. A profile's query and paginated query builders still reserve nothing, and a query that names no reserved argument is unchanged. A reserving query receives no request ID; `received-request-id.md` describes that change.
