---
"@confect/test": minor
---

On the test kernel (`TestConfect.layer`'s `target: "kernel"`), a query or mutation can no longer reach the host's I/O. `fetch` rejects with the `TypeError` the Convex binary gives, `setTimeout` and `setInterval` end the function with the binary's error once its handler returns, and `setImmediate` reads `undefined`, as the binary defines none. `clearTimeout` and `clearInterval` stay allowed, as on the binary. Actions keep the host's `fetch` and timers. The default convex-test target is unchanged.
