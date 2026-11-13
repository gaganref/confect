---
"@confect/cli": minor
"@confect/server": minor
---

Replace `Auth.MutationAuth` with upstream's `MutationAuth.MutationAuth`, in applications and components. The service key changes from `@confect/server/Auth/MutationAuth` to `@confect/server/MutationAuth`. Generated `services.ts` keeps exporting `MutationAuth`, so code that yields the generated alias only needs `confect codegen`; code that imports `Auth.MutationAuth` switches to `MutationAuth.MutationAuth` from `@confect/server`.
