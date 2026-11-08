---
"@confect/core": major
---

Breaking change. Move `Ref.getFunctionReference` to `@confect/core/RefInternal`.
Import `getFunctionReference` from that subpath instead of `Ref` or the package
barrel. The converter preserves supplied native references and caches references
by function name. This separate import lets component authors ban conversion to
native Convex references without banning the `Ref` types and codecs.
