---
"@confect/alchemy": patch
---

For direct `EnvironmentVariables` callers, an entry that resolves to null or undefined is no longer owned or sent as an unset. A name the resource previously wrote is removed and released, including when someone edited its value by hand. Names the resource never owned remain untouched. A plain or Redacted empty string stays a value. With `unownedPolicy: "error"`, a live name whose input resolves to null or undefined is unowned and is refused during plan, read, apply, and delete.
