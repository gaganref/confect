---
"@confect/cli": patch
---

A wrapped `convex/crons.ts` now type-checks when the default export of `confect/crons.ts` is typed more narrowly than `CronJobs.CronJobs`, such as a frozen or branded value. The generated `reduce` took its accumulator type from that export, so a wrapper returning `CronJobs` was rejected. It now names `CronJobs.CronJobs` as the accumulator. The entry with no wrapping section is unchanged.
