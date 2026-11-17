---
"@confect/core": minor
"@confect/cli": minor
"@confect/alchemy": minor
---

Add `Env.providers` to declare provider settings and choose one provider, a failover, or a pool through typed `Backend` settings. Each setting's tag, `provider: { selector, name, required }`, names the selector it belongs to, and `Env.make` refuses a setting named like another slot, selector or setting with `DuplicateEnvKey`. `Backend` matches settings by selector, and validates and encodes every choice with the handler's schema, `Env.providerChoice`. It refuses a choice the handler would refuse with `InvalidChoice` and a named provider's missing required value before declaring resources, or before the environment write when the choice is an output. A component may bind a child's selector to its own selector with the same providers, or to a constant choice; codegen refuses other bindings with `InvalidSelectorBinding`.
