---
"@confect/server": patch
---

A route spec takes no secret. Building a router with `HttpRouter.make` refuses a `FunctionSpec.httpAction` whose path parameters, query, body or response holds a `Schema.Redacted` that `Schema.RedactedFromValue` decodes to, with `RouteHoldsSecret` naming the route and the slot. Effect's HTTP layer decodes a route's request and encodes its response itself, and reports a failure's cause, value included, to an `ErrorReporter` and the logs, so a secret return that failed to encode printed it there. Send a secret through a function instead, which Confect checks in Convex's place. The redaction of a refused request's issue for a route whose request held a secret is removed, as no such route is served.
