---
"@confect/server": patch
"@confect/test": patch
---

Add an internal invocation bridge for `@confect/test`'s kernel. A query, mutation or action handler reached from a bound test invocation runs with that invocation's Effect services. A query's or mutation's `Date` reads its start time through its run, and an action's reads its world's clock as it runs, so a query or mutation an action calls starts at the action's time then. Its `Math.random` and `crypto.getRandomValues` draw from the invocation's random stream. A job it schedules runs as its own request with its world's services, clock and random stream. The public `TestConfect` API is unchanged, and production handlers still start with `Effect.runPromise`.
