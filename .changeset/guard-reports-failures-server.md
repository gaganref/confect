---
"@confect/server": minor
---

A guard made with `Guard.make(name, middleware, { reportsFailures: true })` reports its route failures itself. On its routes Confect writes no log line, its own refusals included, and the guard still gets the same empty 500. `Guard.failure(response)` gives every guard the failure behind `inner`'s response as plain data: `ProductFailed`, or `Refused` with a fixed reason such as `bodyOverCap` or `repeatedCookie`. It holds no cause and no text, so no value from the request reaches the guard through it. A guard without the option, and `Guard.none`, log as before.
