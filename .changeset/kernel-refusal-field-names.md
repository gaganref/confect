---
"@confect/test": major
---

Six refusals of the `kernel` target rename their `name` field, which hid the refusal's own name in logs and `String(error)`.

- `InvalidCron.name`, `CronRandomUnavailable.name`, `CronAbortsBinary.name` and `SnapshotCronMismatch.name` are now `cronName`.
- `UnknownStandingSource.name` is now `functionName`.
- `SnapshotWorldUnresolved.name` is now `worldName`.

`String(error)` for these refusals now prints the refusal's tag, where it printed the cron job's, function's or world's name. The messages are unchanged.

To migrate, read or match `cronName`, `functionName` or `worldName` where a test read or matched `name` on these refusals.
