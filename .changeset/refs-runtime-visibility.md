---
"@confect/core": patch
---

`Refs.make(spec)` now builds `refs.public` and `refs.internal` as separate trees at runtime. `refs.public` holds only public functions and `refs.internal` only internal ones, as their types already said. A group left with no function is dropped. A group and a function that share a name still throw, whatever their visibility.
