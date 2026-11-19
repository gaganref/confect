---
"@confect/core": minor
---

`Guard.make` takes `{ reportsFailures: true }`, and every guard has `reportsFailures`. A guard with it logs its routes' server failures itself, and Confect writes no log line on those routes. A guard made without it, and `Guard.none`, keep Confect's log line.
