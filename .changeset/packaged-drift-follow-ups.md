---
"@confect/cli": patch
"@confect/test": patch
---

A packaged mount's `http.ts` or `http.js` that is neither a regular file nor absent, such as a directory or a link, is now a layout the registry does not read: codegen records it with the reason `http-entry`, and the layers fail `PackagedLayoutUnsupported` until the test declares the mount's `componentRuntimes`. Before, such an entry could disappear after codegen without any open noticing. Each open now also checks the `package.json` of the `convex` whose esbuild resolved the mount by kind and real path, as it checks every walked file, and fails `PackagedComponentChanged` when it has become a link, even to the same bytes. Codegen refuses a linked one with `PackagedComponentUnreadableError`. The testing guide's "Drift detection" now says that every path is checked relative to the package root Node's lookup resolves at open, so a byte-identical package moved behind a link still opens.
