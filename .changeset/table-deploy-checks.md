---
"@confect/core": minor
"@confect/server": minor
"@confect/cli": minor
"@confect/test": minor
---

**A table can now carry deploy checks, which refuse a push, not a call.** A check of a table's declaration alone, such as a library's limit on what it can declare on the table, no longer has to throw as the table's module loads. Convex loads every function's module graph on every call, and that graph binds every table, so a throw there cost every call. Carry the check on the table instead:

```ts
import { Table } from "@confect/core";
import * as Schema from "effect/Schema";

export default Table.make(() =>
  Schema.Struct({ day: Schema.String }),
).deployCheck((table) =>
  table.tableName.length > 32 ? [`${table.tableName}: name too long`] : [],
);
```

`deployCheck` takes the bound table and returns its refusals, each naming what it refuses, or none when the table passes. It returns a new unnamed table and changes nothing else. Making, binding or chaining a table runs no check and builds no schema. A table may carry several checks, which run in the order they were added. `Table.carriesDeployChecks(table)` tells whether a table carries any without running them. `Table.deployRefusals(table)` runs a table's checks and returns their refusals. `Table.verifyDeploy(table)` returns a `Result` that fails with the new tagged `TableRefused`, which names the table and each refusal.

The checks run wherever a backend's Convex schema is built, and nowhere else:

- **At a push.** `Table.tableDefinition` from `@confect/server` now runs a table's checks before it builds the table's Convex definition, and throws `TableRefused` when any refuses. A passing table's definition is built and cached once, as before. A refused one is never cached. Every generated `_generated/convexSchema.ts` builds each table through it. Convex evaluates the app's schema and each component's before it accepts a push, so a refusal fails the push and the deployment keeps serving the last push that succeeded. That includes a component with tables and nothing else, which has no function or router to run a push check. On the pinned local backend the push prints `InvalidSchema: Hit an error while pushing: Uncaught TableRefused: Table "days" is refused: …`. No call builds the Convex schema, so no call runs a check.
- **In codegen.** `confect codegen`, and `confect dev` on each change, runs the checks of every table the backend's schema binds once it has written the generated files. It fails with the new `TableDeployRefusedError`, which lists each refused table and each refusal.
- **In tests.** A generated test subject imports its Convex schema, so importing one whose table is refused throws `TableRefused`. `@confect/test`'s layers also run, first as they build, the checks of each table of the app's database schema, and of each component whose kit gives its `databaseSchema`. A refusal dies with `TableRefused`, so a backend handed a Convex schema built without `Table.tableDefinition`, such as by hand or by a custom kit, refuses too. A component the test registers later with `registerComponent`, once the layer is built, dies with `LateRegistrationUnsupported` and is not installed when a table of the `databaseSchema` it gives carries deploy checks, as it does where push checks are involved, since only a build runs them. The session stays usable, as such a refusal registers nothing. `pushChecks: "skip"` skips them, and registers such a component as before, unverified. `Preflight.run(modules, { schema })` runs them for `schema` and now fails with `TableRefused` too.

A table that a table module builds but leaves out of the schema, such as a named export beside its default export, is never deployed, and nothing runs its checks.

**A section that sets `wrapsSchema` must now call `Table.tableDefinition` on each table it is passed**, whether it returns that definition or builds another from it, so the checks still run at a push. A wrapper that does not must run them itself with `Table.verifyDeploy` and throw the refusal. Otherwise a push deploys a table its checks refuse, although codegen still refuses it.

A table without checks behaves exactly as before. Generated files do not change.
