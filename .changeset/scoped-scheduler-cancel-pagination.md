---
"@confect/server": minor
---

Add `Scheduler.cancel(id)` to component services. Pass the component-scoped `_scheduled_functions` ID returned by `runAfter` or `runAt` to cancel the scheduled function.

Reject native database `.paginate()` calls in components at compile time with "Native pagination is unavailable in components. Use QueryStream.paginate for index queries." Use `QueryStream.paginate` for component index queries. Application-target schemas retain native pagination. Generic helpers that call native pagination must constrain their schema to an application target.
