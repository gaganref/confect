---
"@confect/alchemy": minor
---

Run each mount's `init` on every Alchemy push, local and cloud. After the code push, and before the push releases the deployment's lock, the push asks the backend's `confectDeploy:steps` for its steps and runs every mount's `init` with its install `args`, one mount at a time in declaration order, with a Confect component's own mounts after its `init`. A failing mount stops the push with `MountInitFailed`, `<mount>: init failed; earlier mounts are applied, and the next push retries`; the next push converges. A push outside Alchemy skips `init`.
