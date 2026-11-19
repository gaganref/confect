---
"@confect/test": patch
---

On the test kernel, a loaded copy of `@confect/test` that nothing reaches any more is released from the process-wide hooks it registered in: the I/O guards, `globalThis.Convex`, the `Date` wrapper, the provider-port holder and `process.env`. Each registry held every copy strongly, so a test runner that reloads modules, as Vitest's watch mode or `vi.resetModules()` does, kept every reloaded copy's module graph alive. The registries now hold each copy weakly, and a copy that can still run keeps its registration. A copy from an earlier release that loads beside this one reads the registries as before.
