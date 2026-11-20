---
"@confect/core": patch
"@confect/cli": minor
---

A manifest section's `render` and `verify.check` now get each function's `spec`, typed as `FunctionSpec.AnyWithProps`, beside its `path`, `source` and `visibility`, and `functionOf(spec)`, which returns the function whose `spec` is that very object. Codegen bundles the files a section matched and every spec file in one build, so a spec a matched file reaches through imports that build bundles, directly or through other modules, is the object `functions[i].spec` is. A section maps a spec to its function with `functionOf`:

```ts
render: ({ modules, functionOf }) => {
  const included = modules[0].exports.included as ReadonlyArray<unknown>;
  const paths = included.map((spec) => functionOf(spec).path);
  return { contents: `export default ${JSON.stringify(paths)};\n`, errors: [] };
},
```

A spec reached any other way is a different object, and `functionOf` throws rather than name no function or the wrong one. That happens when a module loads a spec file through `createRequire` or a `Module` instance's `require`, or through a package in `node_modules` that re-exports a spec from `confect/`. It also throws for a spec no group registers. The message names the spec's function and these causes.

`spec` is not enumerable, so serializing or spreading a function leaves it out, and a section that writes `functions` as JSON writes what it wrote before. Matched files run in the order they ran before, then the spec files. A module two matched files import now runs once, where each file had its own copy before. Packages Node loads from `node_modules` now all load before any matched file runs, where each loaded when the first matched file that imports it ran.

When the files cannot share one build, codegen bundles each matched file on its own, and reading `spec` or calling `functionOf` throws why. That happens when a module calls `import()` or `require()` with a path esbuild cannot read from the source, such as `import(new URL("./notes.spec.ts", import.meta.url).href)`, or with a path esbuild cannot resolve inside code that handles the failure. It also happens when `NODE_OPTIONS` sets export conditions, when the files fall under different `tsconfig.json` files, and when a package Node loads throws as it initializes. Codegen then names the failing file and records the section inputs as it did before.

A backend whose sections do not read `spec` or call `functionOf` generates the same files, with two exceptions. A module two matched files import may keep state that each file read on its own copy before. A package one matched file imports may read state an earlier matched file sets: when `a.ts` sets a global and a package only `b.ts` imports reads it as it loads, the package saw the global set before and now sees it unset.
