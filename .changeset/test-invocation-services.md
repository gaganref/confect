---
"@confect/server": patch
"@confect/test": patch
---

Add an internal invocation bridge for `@confect/test`'s kernel. A query, mutation or action handler reached from a bound test invocation runs with that invocation's Effect services. Its `Date` reads the invocation's start time, and its `Math.random` and `crypto.getRandomValues` draw from the invocation's random stream. A job it schedules runs as its own request with its world's services, clock and random stream. The public `TestConfect` API is unchanged, and production handlers still start with `Effect.runPromise`.
