---
"@confect/core": patch
"@confect/test": patch
---

`SecretSchema.hasSecret` follows a schema's encoding chain and its record keys, so a schema whose decoded type holds no secret but whose encoding does, such as `Schema.RedactedFromValue(Schema.String).pipe(Schema.decodeTo(Schema.String, …))`, holds one. A function side with such a schema registers no Convex validator, so Convex's validator no longer prints the value it refuses, and Confect checks the side instead. A route refuses it in any slot. `Schema.flip` of a secret is refused as a function side at registration. The walk ends on every recursive schema, including the forms `Schema.encodeKeys` and `Schema.encode` unfold, and reads a schema that reaches 10,000 distinct nodes as holding a secret. The test kit walks such a value by the wire node Effect parses it with, marks only the secrets placed there, and marks the whole value when a transformation stands between the stored value and a secret or a record's keys are secret.
