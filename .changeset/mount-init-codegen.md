---
"@confect/cli": minor
---

`confect codegen` writes `convex/confectDeploy.ts` for a declared backend: a `MountInit.mutation` over every mount whose component declares `init` or has a `confectDeploy.ts` of its own, in declaration order, each imported from `confect/<name>.ts`. Codegen fails when such a mount is not exported from that file, and removes the module when no mount needs it.
