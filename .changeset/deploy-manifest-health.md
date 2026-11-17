---
"@confect/alchemy": major
"@confect/cli": major
---

Verify manifest-backed `Confect.Backend` deployments twice. After prepare and before the push, `Convex.Code` compares the digest prepare wrote into `convex/confectHealth.ts` with the stack's `manifestDigest` and fails with `StaleManifest`, pushing nothing, when they differ. After mount initialization, inside the push lock, it calls the generated internal query `confectHealth:digest`; missing, failed, non-string, and stale answers fail with `HealthCheckFailed`. Both errors are exported from the `Convex` namespace. A standalone `Convex.Code` can enable the checks with `manifestDigest: manifest.digest`.

Run `confect codegen`, commit the generated files and deploy again when a deploy fails with `StaleManifest`. The health check does not roll back code or initialization that already completed.
