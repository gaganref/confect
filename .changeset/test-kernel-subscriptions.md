---
"@confect/test": patch
---

The internal test kernel runs query subscriptions. A subscription goes stale when a commit changes what its query read, or when its client's identity changes and the query read the identity. Time passing alone never reruns it, as on the Convex binary. Refreshing reruns the stale subscriptions and lists the values that changed, and a full rerun of every subscription checks that none was missed. A paginated subscription keeps the page end its first run read. `Date` inside a query or mutation answers the kernel's time at its start. The public `TestConfect` API is unchanged and still runs on convex-test.
