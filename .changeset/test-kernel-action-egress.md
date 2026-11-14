---
"@confect/test": minor
---

On the test kernel (`TestConfect.layer`'s `target: "kernel"`), a raw `fetch` in an action, a Node action included, now fails the action with `BackendRefusal` `UndeclaredFetch`, naming the action and the host. The fetch never leaves the process, and the action fails at once whatever its handler catches, runs no later call and logs nothing more; any function that has returned logs nothing more either. Convex performs this fetch, so this is the kernel's one deliberate departure from the binary: egress goes through a provider port instead, whose call the kernel holds as a command the test answers until the action ends, when its commands are cancelled. A kernel snapshot carries the next command's ID and the cancelled commands, so a restore numbers and refuses them as the uninterrupted run would; its format moves to 5, whose body carries the deployment's signing key (#134) beside the command history. The default convex-test target is unchanged.
