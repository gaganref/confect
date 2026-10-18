---
"@confect/test": minor
"@confect/cli": minor
"@confect/alchemy": minor
---

Create test layers from a declared app with `TestConfect.layer(app)`, importing the generated test app from `confect/_generated/testing`. Component registration and mounted HTTP prefixes follow the declaration, including nested installations. An authored declaration can also be passed with its registry as `TestConfect.layer(app, registry)`. The existing schema-based constructor remains available.

Pass a generated `manifest` to `Confect.Backend` to require its declared env keys and reject unknown keys, unredacted secrets, and invalid literal values. Backends without a manifest keep accepting an untyped env record.

`@confect/alchemy` now requires `@confect/core` as a peer for manifest types.
