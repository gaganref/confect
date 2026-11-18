---
"@confect/cli": minor
---

`confect codegen` writes `convex/confectDeploy.ts` for a declared backend: a `MountInit.mutation` over every mount whose component declares `init` or has a `confectDeploy.ts` of its own, in declaration order, each imported from the TypeScript file directly in `confect/` that exports it among those `app.ts` imports statically, or else from `confect/<name>.ts`, so one `confect/components.ts` can hold several. Codegen fails, naming the mount, when neither exports it or when two root files do, a re-export included, and removes the module when no mount needs it. Each mount is imported under its own local name, so equal or default export names do not collide. Codegen refuses a `confect/confectDeploy.spec.ts` group, whose functions would land in that file.
