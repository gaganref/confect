---
"@confect/core": minor
"@confect/cli": minor
"@confect/test": minor
"@confect/alchemy": patch
---

When an app can import `@confect/test`, codegen writes a `TestBackend` export into its `_generated/testing.ts`: its public groups with owners and open lists, obligations, laws, ports, manifest digest, settings, and its mounts in push order with the settings each binds. Its registry gains `secrets` for the kernel's redaction. `TestBackend.layer` opens it on the test kernel, runs each mount's `init` in the order a push does, through the new `@confect/core/MountSteps` that Alchemy's push also calls, then a seed, and gives each component only the settings its mount binds. A kit passes its component's secret policy to `registerComponent`; a packaged Confect component whose kit exports none fails `TestKitSecretsMissingError`. `@confect/core/SecretSchema` is the one secret walk codegen and the kernel share. A manifest section adds facts through its new `testing` hook, checked against the backend. The test registry now holds only the modules a push registers, and a package mount with no test kit fails `MissingTestKitError`.
