---
"@confect/core": patch
---

A `GenericId` schema's own refinement states an exact JSON Schema that adds nothing to its string. A tool that reads a schema's checks can now tell an ID apart from a filter that JSON Schema cannot express, and a `oneOf` union that holds an ID exports as `oneOf` instead of `anyOf`. Decoding, encoding and a plain ID's JSON Schema stay the same.
