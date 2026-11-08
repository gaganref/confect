---
"@confect/server": minor
---

Add `Scheduler.cancel(id)` to component services. Pass the component-scoped `_scheduled_functions` ID returned by `runAfter` or `runAt` to cancel the scheduled function.
