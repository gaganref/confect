---
"@confect/server": minor
---

Dispatch OPTIONS on a declared path through its router middleware, without running its handler. Select the route with Access-Control-Request-Method, preserve explicit OPTIONS routes, and leave undeclared paths at 404. Endpoint middleware sees OPTIONS when the router receives `{ api }`.
