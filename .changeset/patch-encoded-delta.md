---
"@confect/server": minor
---

`DatabaseWriter.patch` now writes only the fields it is given, as native Convex `patch` does. Each patched field is encoded through its own codec, and the rest of the stored document is left byte for byte. Previously `patch` decoded the document, merged the patch and replaced the whole document.

What changes for a consumer:

- Untouched fields are no longer re-normalised by their encoders. A stored `"001.00"` under `Schema.FiniteFromString` stays `"001.00"` instead of becoming `"1"`.
- Fields outside the schema are no longer removed by a patch.
- A patch can repair a stored field that no longer decodes, because the complete result must decode before the write. Such a patch previously failed with `DocumentDecodeError`.

Other failures are unchanged. A value its field codec rejects, an unset required field or a failing struct-level check fails with `DocumentEncodeError`, and a stored document that the patch does not repair fails with `DocumentDecodeError`.

Some table schemas still take the full replace. A union, or a transformation over the whole struct (such as `Schema.decodeTo` or `Schema.encodeKeys`), can make one field's encoding depend on another. A check on the struct itself must see the decoded values before they are encoded. A key under an index signature has no field codec of its own. For those tables `patch` decodes the document, merges the patch and replaces the whole document.
