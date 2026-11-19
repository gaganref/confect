---
"@confect/test": patch
---

`TestComponent.exports` and `TestComponent.callbacks` keep a packaged refusal as the `cause` of the `CaseFailed` they fail with, so a caller can tell `PackagedComponentChanged` from `PackagedLayoutUnsupported` by its tag instead of by parsing `reason`. `reason` still holds the refusal's message, and a case that fails for any other reason has no `cause`.
