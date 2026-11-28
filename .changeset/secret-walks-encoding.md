---
"@confect/core": patch
"@confect/test": patch
---

`SecretSchema.hasSecret` follows a schema's encoding chain, so a schema whose decoded type holds no secret but whose encoding does, such as `Secret.pipe(Schema.decodeTo(Schema.String, …))`, holds one. A function side with such a schema registers no Convex validator, so Convex's validator no longer prints the value it refuses, and Confect checks the side instead. A route refuses it in any slot. The test kit stores it as a secret and marks the whole value in snapshots and failure reports, since the decoded type does not say where in the stored form the secret sits.
