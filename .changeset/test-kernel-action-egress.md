---
"@confect/test": minor
---

On the test kernel (`TestConfect.layer`'s `target: "kernel"`), a raw `fetch` in an action, a Node action included, now fails the action with `BackendRefusal` `UndeclaredFetch`, naming the action and the host. The fetch never leaves the process, and the action fails whatever its handler catches. Convex performs this fetch, so this is the kernel's one deliberate departure from the binary: egress goes through a provider port instead, whose call the kernel holds as a command the test answers. The default convex-test target is unchanged.
