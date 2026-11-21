---
"@confect/core": minor
"@confect/cli": minor
---

A manifest section can now wrap the deployment schema. Set `wrapsSchema: true` on the section's `generate` and export `tables` from the file it renders. `tables` takes the backend's Confect tables by name and returns the Convex table definitions `defineSchema` gets, so it can add fields, index terms and tables. `_generated/convexSchema.ts` then imports the section's file first and passes every table through `tables`. At most one section may set it, and codegen refuses it on a `.json` or `.md` file. Full runs and incremental runs in `confect dev` write the schema with the current wrapper, so a section that starts or stops wrapping rewrites it. With no wrapping section, the schema is the same as before.
