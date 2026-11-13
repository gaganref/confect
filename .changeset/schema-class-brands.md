---
"@confect/alchemy": major
"@confect/server": major
---

Published Schema error classes now carry a brand, so a structurally equal object no longer type-checks as one of them. Build their values with the class's `make`, or decode them with its schema.

- In `@confect/alchemy`: `ConvexApiError`, `ConvexNotFound`, `ConvexConflict`, `ConvexFunctionError`, `DeployKeyRecoveryRequired`, `DeployKeyChangeRequiresNewResource`, `DeploymentIdentityChange`, `UnsupportedLocalDeployment`, `AmbiguousDeployment`, `EnvironmentTargetChange`, `ProjectTeamChange` and `AmbiguousProject`, and the internal `InvalidDeploymentTarget`, `CommandError`, `LifecycleStateError`, `LocalBackendError`, `MountInitFailed` and `PushLockError`.
- In `@confect/server`: `Callback.CallbackContractMismatch` and `OfficialComponent.ComponentCallFailed`.
