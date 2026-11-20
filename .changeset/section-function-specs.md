---
"@confect/core": patch
"@confect/cli": minor
---

A manifest section's `render` and `verify.check` now get each function's `spec`, typed as `FunctionSpec.AnyWithProps`, beside its `path`, `source` and `visibility`. Codegen bundles the files a section matched and every spec file in one build, so a matched file that imports a spec, directly or through other modules, holds the very object `functions[i].spec` is. A section can then find a function by identity:

```ts
render: ({ modules, functions }) => {
  const included = modules[0].exports.included as ReadonlyArray<unknown>;
  const paths = included.map(
    (spec) => functions.find((fn) => fn.spec === spec)?.path,
  );
  return { contents: `export default ${JSON.stringify(paths)};\n`, errors: [] };
},
```

`spec` is not enumerable, so serializing or spreading a function leaves it out, and a section that writes `functions` as JSON writes what it wrote before. When the files cannot share one build, such as when `NODE_OPTIONS` sets export conditions or the files fall under different `tsconfig.json` files, codegen bundles each matched file on its own, and reading `spec` throws why. A backend whose sections do not read `spec` generates byte-identical files.
