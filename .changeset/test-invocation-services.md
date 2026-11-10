---
"@confect/server": patch
"@confect/test": patch
---

Add an internal invocation bridge for `@confect/test`'s kernel. A query, mutation or action handler reached from a bound test invocation runs with that invocation's Effect services, and a job it schedules runs as its own request with its world's services. The public `TestConfect` API is unchanged, and production handlers still start with `Effect.runPromise`.
