---
"@confect/core": minor
"@confect/cli": minor
"@confect/test": minor
---

Codegen writes a `TestBackend` export into an app's `_generated/testing.ts`: its public groups with owners and open lists, obligations, laws, ports, manifest digest, mounts in init order, settings and secret paths. `TestBackend.layer` opens it on the test kernel, runs each mount's `init` nested before parent, then a seed. A manifest section adds facts through its new `testing` hook. The test registry now holds only the modules a push registers, and a package mount with no test kit fails `MissingTestKitError`.
