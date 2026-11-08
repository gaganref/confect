---
"@confect/core": minor
---

`Component.make` takes an optional `contract`, the component's `_generated/component` contract. A mount of such a descriptor has `callbackArgs(slot)`, which returns a callback slot's contract args with the component's ids typed for that mount. A mount's name now keeps its literal type, so two mounts of one component carry distinct id types.
