---
"@confect/alchemy": minor
---

Add opt-in safety options to `Convex.EnvironmentVariables` for drift refusal, matching-value adoption with `adoptMatching`, unowned-name refusal, a shared deployment push lock, and bounded write-conflict retries. Reruns recover after a lost write response when live values already match the declaration. Existing declarations keep their current behavior.
