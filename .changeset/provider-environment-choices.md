---
"@confect/core": major
"@confect/cli": major
"@confect/alchemy": major
---

Add `Env.providers` to declare provider settings and choose one provider, a failover, or a pool through typed `Backend` settings. Each setting's tag, `provider: { selector, name, required }`, names the selector it belongs to, and `Env.make` refuses a setting named like another slot, selector or setting with `DuplicateEnvKey`. `Backend` matches settings by selector, and validates and encodes every choice with the handler's schema, `Env.providerChoice`. It refuses a choice the handler would refuse with `InvalidChoice` and a named provider's missing required value before environment writes or code pushes. A settings record with no deferred inputs fails before resource declaration. Outputs, Effects, Configs and nested choice inputs keep their dependencies and validate on resolution. A component may bind a child's selector to its own selector with the same providers, or to a constant choice; codegen refuses other bindings with `InvalidSelectorBinding`.

Required settings in `env`, `mounts`, and `automatic`, including every named provider's required settings, reject undefined, empty strings and empty Redacted values as `Missing` after resolution. Secret checks also run on resolved values. Supplied settings and mount records use own keys only. Each setting belongs to one provider of one selector; shared values are ordinary slots.
