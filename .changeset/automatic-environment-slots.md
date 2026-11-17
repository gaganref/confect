---
"@confect/core": minor
"@confect/cli": minor
"@confect/alchemy": minor
---

Add `Env.automatic(field)` for required variables a framework supplies through `Backend.automatic`, with automatic slots shared by name through nested components and excluded from application env and mount bindings. Automatic slots of one name must agree on kind, values and optionality; `AutomaticSlotConflict` names the sibling mount that declares another shape, and the manifest schema refuses an optional automatic slot.
