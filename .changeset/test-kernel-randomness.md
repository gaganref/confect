---
"@confect/test": patch
---

The test kernel's random sources draw from the supplied stream in every kernel function and module load: Confect and plain Convex functions, component functions and lazily imported modules alike. `crypto.getRandomValues` answers as the Convex binary's does: a fill past 65,536 bytes throws `TypeError`, a non-integer array throws the binary's `TypeMismatchError`, and a detached call draws. `crypto.randomUUID` draws from the stream too. A module that draws while it loads draws from the stream of the backend's world, which `TestConfect.layer`'s `seed` starts, and with no world the open refuses with `LoadRandomUnavailable`. `crypto.subtle` operations that draw cryptographic randomness reject with the binary's error in a query, a mutation and a module load, and with `RequiresBinary` in an action.
