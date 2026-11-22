---
"@confect/cli": major
---

Breaking change. A host's `confect/_generated/components.ts` types each mount of an in-repo Confect component from the component's `confect/_generated/component.ts`, which now exports `ComponentApi` beside the contract. A component is an in-repo Confect component when its definition directory is named `convex` and has a sibling `confect/` directory, the layout `confect codegen --component-dir` writes. Before, the registry imported the component's `convex/_generated/component.js`, which only Convex writes. Projects committed a hand-written stub there, and Convex overwrote it on every push. A component mounted by package name and an in-repo component without `confect/` keep reading `<definition>/_generated/component.js`.

Who is affected: a host that mounts an in-repo Confect component. Its registry names a new module, so the component's contract must be regenerated before the host type-checks.

To migrate:

1. Rerun `confect codegen --component-dir <component>/convex` for each Confect component, then `confect codegen` for the host.
2. Delete any hand-written `<component>/convex/_generated/component.ts` stub and git-ignore `<component>/convex/_generated/`. Convex writes that folder on each push.
3. Import `ComponentApi` from `<component>/confect/_generated/component` where code imported it from `<component>/convex/_generated/component`.
4. If plain Convex host code calls an in-repo Confect component through `convex/_generated/api`, ignore the host's `convex/_generated/` too, or import `components` from `confect/_generated/components`. A tracked `api.d.ts` that imports an ignored component folder leaves those calls untyped without an error.
5. A package that ships a Confect component maps its `./_generated/component.js` export to `confect/_generated/component`.
