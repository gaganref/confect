---
"@confect/core": minor
"@confect/test": minor
"@confect/cli": minor
"@confect/alchemy": patch
---

`TestBackend.layer` and `TestComponent`'s layer take `mounts` and `automatic`, named and typed as `Backend` takes them from the generated manifest, and check them with the same rules, now shared as `Manifest.variables`, `Manifest.settle` and the other checks in `@confect/core`, each returning a tagged refusal with only the reasons it can produce (`Manifest.SettingRefused` is their union). Each value reaches its component under the name production gives it, through promoted nested slots and every parent's automatic binding. A secret slot's value is marked in failure reports. A missing required value fails `TestConfigMissing` with `supply`, the option it goes in, and any other refusal fails the new `TestConfigInvalid` with `Backend`'s reason. Codegen writes `manifest` on the generated subject and binds each mount's slots as the generated `convex.config.ts` binds them, so an app mount's open slot is bound to its deployment variable rather than recorded as `{ open: true }`. An app's own `Env.automatic` settings move from `config` to `automatic`.
