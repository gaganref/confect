---
"@confect/alchemy": minor
"@confect/cli": minor
---

Verify manifest-backed `Confect.Backend` deployments against the generated internal query `confectHealth:digest` after mount initialization, inside the push lock. Missing, failed, non-string, and stale answers fail the deployment. A standalone `Convex.Code` can enable the check with `digest: manifest.digest`.

Regenerate the app before the stack imports its manifest, and include the generated `convex/confectHealth.ts` in the push. The check does not roll back code or initialization that already completed.
