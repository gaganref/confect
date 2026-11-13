---
"@confect/test": minor
"@confect/server": patch
---

On the test kernel (`TestConfect.layer`'s `target: "kernel"`), a query or mutation can no longer reach the host's I/O. `fetch` and a multipart `formData()` reject with the errors the Convex binary gives, and `setTimeout` and `setInterval` end the function with the binary's error at once, even while the handler awaits the timer. Queries, mutations and actions other than Node actions find no `setImmediate` or `queueMicrotask`, as in Convex's isolate. `clearTimeout` and `clearInterval` stay allowed. Add the new `@confect/test/setup` to Vitest's `setupFiles` so these globals are guarded before any test module loads. `RegisteredNodeFunction.make` marks the function it registers so the kernel can tell a Node action from an isolate one. The default convex-test target is unchanged.
