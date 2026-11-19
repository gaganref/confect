---
"@confect/test": patch
---

On the test kernel, a module load runs under its own backend's guards and environment however deep the calls that lead to it nest. When one backend's action called into a second backend whose function opened a fresh backend, the fresh backend's modules loaded with the enclosing function's environment and runtime: a module without `"use node"` saw Node's `setImmediate` and `queueMicrotask` inside a Node action, and `process.env` answered from the calling function's component. A function called while a module loads likewise read the loading module's environment instead of its own component's. Each copy of the kernel now keeps a function and a module load in one async-local frame, so only the innermost one answers.
