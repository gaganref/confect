---
"@confect/server": patch
---

`DatabaseWriter.patch` now writes only the fields it is given, as native Convex `patch` does. Each patched field is encoded through its own codec, and the rest of the stored document is left byte for byte. Fields the table schema does not carry are kept, and an encoded value the patch did not touch is not normalised again. A stored `"001.00"` under `Schema.FiniteFromString` stays `"001.00"` instead of becoming `"1"`. Previously `patch` decoded the document, merged the patch and replaced the whole document.

The stored document with the patch applied must still decode under the table schema. A patch can therefore repair a field that no longer decodes, which previously failed with `DocumentDecodeError`. Other failures are unchanged. A value its field codec rejects, an unset required field or a failing struct-level check fails with `DocumentEncodeError`, and a stored document that stays invalid fails with `DocumentDecodeError`.

When the table schema is a union, or transforms the whole struct (such as `Schema.decodeTo` or `Schema.encodeKeys`), one field's encoding can depend on another. For those tables `patch` still decodes the document, merges the patch and replaces the whole document.
