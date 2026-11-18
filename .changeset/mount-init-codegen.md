---
"@confect/cli": minor
---

`confect codegen` writes `convex/confectDeploy.ts` for a declared backend: a `MountInit.mutation` over every mount whose component declares `init` or has a `confectDeploy.ts` of its own, in declaration order, each imported from the file directly in `confect/` that exports it among those `app.ts` imports, so one `confect/components.ts` can hold several. Codegen fails, naming the mount, when no such file exports it or when two do, and removes the module when no mount needs it. Each mount is imported under its own local name, so equal or default export names do not collide. Codegen refuses a `confect/confectDeploy.spec.ts` group, whose functions would land in that file.
