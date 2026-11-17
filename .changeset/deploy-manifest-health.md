---
"@confect/core": major
"@confect/alchemy": major
"@confect/cli": major
---

Verify manifest-backed `Confect.Backend` deployments twice. After prepare and before the push, `Convex.Code` compares the digest prepare wrote into `convex/confectHealth.ts` with the stack's `manifestDigest` and fails with `StaleManifest`, pushing nothing, when they differ. After mount initialization, inside the push lock, it calls the generated internal query `confectHealth:digest`; missing, failed, non-string, and stale answers fail with `HealthCheckFailed`. Both errors are exported from the `Convex` namespace. A standalone `Convex.Code` can enable the checks with `manifestDigest: manifest.digest`.

Run `confect codegen`, commit the generated files and deploy again when a deploy fails with `StaleManifest`. The health check does not roll back code or initialization that already completed.

Core's `HealthModule.render` and `HealthModule.read` share the exact generated text contract. The pre-push reader accepts only that text, allowing LF or CRLF. A missing or edited file fails with `StaleManifest.reason` `NotGenerated`; another generated digest uses `DifferentDigest`. Both keep `expected` and optional `generated`. `healthModulePath` identifies the health file Alchemy tried to read when the functions directory can be resolved. Do not format or edit `convex/confectHealth.ts`; prepare regenerates it on every deployment.

Report the health file's actual `healthModulePath` from the functions directory in `convex.json` when it can be resolved. For `NotGenerated`, do not edit or format that file and regenerate it. Keep the CLI that generates it and the Alchemy package that reads it on the same Confect release. Normalize CRLF to LF only; refuse a lone carriage return.
