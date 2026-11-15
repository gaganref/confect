---
"@confect/core": minor
"@confect/cli": minor
---

A manifest section can now wrap the backend's cron jobs. To opt in, set `wrapsCrons: true` on the section's `generate` and export `crons` from the file it renders. `crons` takes Confect's `CronJobs` and returns `CronJobs`. `convex/crons.ts` then passes `confect/crons.ts`'s default export through each wrapping section's `crons`, in the order `App.make` declares the sections, and deploys the result's `convexCronJobs`. A wrapper that throws stops the deployment from loading the entry. A wrapper whose types don't match fails to type-check. With no wrapping section, `convex/crons.ts` is the same as before.

In a declared backend, an edit to `confect/crons.ts` now runs full generation, as an edit to `confect/http.ts` does, so `confect dev` never writes the entry without its wrappers.
