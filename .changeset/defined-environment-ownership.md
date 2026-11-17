---
"@confect/alchemy": patch
---

For direct `EnvironmentVariables` callers, an entry that resolves to null or undefined is no longer owned or sent as an unset. Under the default `driftPolicy: "overwrite"`, a name the resource introduced is removed and released even when someone edited its value by hand. An adopted name regains its original value when ownership ends. With `driftPolicy: "error"`, an external edit is refused. Names the resource never owned remain untouched. A plain or Redacted empty string stays a value. With `unownedPolicy: "error"`, a live name the resource does not own is refused during plan, read, apply, and delete when its input resolves to null or undefined.
