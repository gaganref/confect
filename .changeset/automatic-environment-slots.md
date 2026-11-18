---
"@confect/core": major
"@confect/cli": major
"@confect/alchemy": major
---

Add `Env.automatic(field)` for required variables a framework supplies through `Backend.automatic`, with automatic slots shared by name through nested components and excluded from application env and mount bindings. Automatic slots of one name must agree on kind, values and optionality; `AutomaticSlotConflict` names the sibling mount that declares another shape, and the manifest schema refuses an optional automatic slot.

Provider selectors and settings cannot be automatic. `Env.automatic` refuses selectors statically and throws `InvalidEnvProviders` with reason `AutomaticSelector` or `AutomaticSetting` at runtime. The manifest schema refuses automatic provider selectors and settings and repeated values. Automatic literal slots compare distinct value sets in both directions. `Env.literals` rejects duplicate values statically where possible and with `DuplicateEnvValue` at runtime.

Refuse a plain string for an automatic secret with `InvalidAutomaticSetting` and reason `PlainSecret`, directing the value to `Backend.automatic`.
