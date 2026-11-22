---
"@confect/cli": major
---

Breaking change. Every `confect/_generated/components.ts`, the host's and that of any Confect component that mounts components, types each mount of an in-repo Confect component from the component's `confect/_generated/component.ts`, which now exports `ComponentApi` beside the contract. A mounted definition directory is an in-repo Confect component when it holds the `schema.ts` that `confect codegen --component-dir` writes, whatever the directory is named. Before, the registry imported the component's `convex/_generated/component.js`, which only Convex writes. Projects committed a hand-written stub there, and Convex overwrote it on every push. A component mounted by package name and an in-repo plain Convex component keep reading `<definition>/_generated/component.js`. `confect codegen --component-dir` now creates the definition directory when it is missing.

Who is affected: a host, or a Confect component, that mounts an in-repo Confect component. Its registry names a new module, so the mounted component's contract must be regenerated before the host type-checks.

To migrate:

1. Rerun `confect codegen --component-dir <component>/convex` for each Confect component, then `confect codegen` for the host.
2. Delete any hand-written `<component>/convex/_generated/component.ts` stub and git-ignore `<component>/convex/_generated/`. Convex writes that folder on each push and deletes files it did not write.
3. Import `ComponentApi` from `<component>/confect/_generated/component` where code imported it from `<component>/convex/_generated/component`.
4. If plain Convex host code calls an in-repo Confect component through `convex/_generated/api`, ignore the host's `convex/_generated/` too, or import `components` from `confect/_generated/components`. A tracked `api.d.ts` that imports an ignored component folder leaves those calls untyped without an error.
5. A test that globs a Confect component's `convex/**` into convex-test adds a stand-in `_generated` key and leaves Convex's folder out of the glob, or registers the component through Confect's generated `confect/_generated/testing.ts`.
6. A package that ships a Confect component maps its `./_generated/component.js` export to `confect/_generated/component`, or to a file outside any `_generated/` folder that re-exports it.
7. A workspace-linked package that ships a TypeScript `convex.config.ts` gets `api.ts`, `component.ts`, `dataModel.ts` and `server.ts` written into the `_generated/` beside it on each push. Git-ignore that folder by the package's path.
