---
"@confect/server": minor
---

Add an optional effectful cursor envelope to QueryStream.paginate. Open both input cursors before decoding and seal every continuation and split cursor, including end sentinels.
