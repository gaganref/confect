---
"@confect/core": minor
---

`FunctionSpec.PathParams<Path>` and `FunctionSpec.DeclaredPath<Path, ArgsFields>` are exported, so a wrapper around `FunctionSpec.httpAction` can type its `path` option as `Path & NoInfer<FunctionSpec.DeclaredPath<Path, Args>>`, keep the compile-time refusal of a path parameter no argument declares, and still build its declarations. `never` args, the default of a wrapper given no `args`, count as no args at all, so such a wrapper refuses every path parameter.
