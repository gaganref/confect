---
"@confect/core": minor
"@confect/cli": minor
"@confect/test": minor
---

When an app can import `@confect/test`, codegen writes a `TestBackend` export into its `_generated/testing.ts`: its public groups with owners and open lists, obligations, laws, ports, manifest digest, mounts in init order and settings, and its registry gains `secrets` for the kernel's redaction. `TestBackend.layer` opens it on the test kernel, runs each mount's `init` nested before parent, then a seed. A manifest section adds facts through its new `testing` hook. The test registry now holds only the modules a push registers, and a package mount with no test kit fails `MissingTestKitError`.
