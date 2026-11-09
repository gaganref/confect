---
"@confect/core": minor
"@confect/server": minor
---

Add `Mount.initCall(mount, create)`, a mount's `init` call: its component path, the `init` function name and the install args encoded, with each callback slot's host ref made a handle by `create`. Add `MountInit.mutation(entries)`, the internal mutation that makes each mount's callback handles with `Callback.create` and returns the steps a push runs, in declaration order, ending at the first mount whose handles cannot be made.
