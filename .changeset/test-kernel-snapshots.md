---
"@confect/test": patch
---

The internal test kernel exports its committed state as snapshot bytes and restores them into a fresh test backend. A snapshot carries every component's rows and versions, the write log, the jobs with their targets, standing and world names, the clock's floor and the identity counters. Two exports of one state are the same bytes. The header binds the body's SHA-256 digest, and a restore refuses tampered bytes with `SnapshotDigestMismatch`. Replaying the same calls after a restore reaches the same state as the run that never stopped, and a function handle stored in a row still resolves. The public `TestConfect` API is unchanged.
