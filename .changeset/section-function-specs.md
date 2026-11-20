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

`spec` is not enumerable, so serializing or spreading a function leaves it out, and a section that writes `functions` as JSON writes what it wrote before. Matched files run in the order they ran before, then the spec files. A module two matched files import now runs once, where each file had its own copy before, and packages Node loads from `node_modules` load before any matched file runs. When the files cannot share one build, codegen bundles each matched file on its own, and reading `spec` throws why. That happens when a module calls `import()` or `require()` with a path esbuild cannot read from the source, such as `import(new URL("./notes.spec.ts", import.meta.url).href)`, when `NODE_OPTIONS` sets export conditions, or when the files fall under different `tsconfig.json` files. A backend whose sections do not read `spec` generates the same files, unless a module two matched files import keeps state that each file read on its own copy before.
