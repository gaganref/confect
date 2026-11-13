---
"@confect/test": patch
---

The test kernel's `crypto.getRandomValues` answers as the Convex binary's does: a fill past 65,536 bytes throws `TypeError`, a non-integer array throws the binary's `TypeMismatchError`, and a detached call draws.
