---
"@confect/test": patch
---

The test kernel's `crypto.getRandomValues` answers as the Convex binary's does: a fill past 65,536 bytes throws `TypeError`, a non-integer array throws the binary's `TypeMismatchError`, and a detached call draws. `crypto.randomUUID` draws from the supplied stream too. A module that draws while it loads draws from the stream of the backend's world, which `TestConfect.layer`'s `seed` starts, and with no world the open refuses with `LoadRandomUnavailable`.
