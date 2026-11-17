---
"@confect/alchemy": minor
---

Add opt-in safety options to `Convex.EnvironmentVariables` for drift refusal, matching-value adoption with `adoptMatching`, unowned-name refusal, a shared deployment push lock, and bounded write-conflict retries. Existing declarations keep their current behavior.

With `driftPolicy: "error"`, resolved desired values are checked for drift at plan time. Unresolved values, including an unresolved desired map, wait until apply, after upstream resources such as a code push and before any environment write. A live value equal to the resolved desired value permits recovery after a lost write response without another write. A value differing from both the stored snapshot and the desired value is refused. A previously present owned name deleted outside the stack is still refused at plan time, even if its desired value or map is unresolved.
