import { CommitTs, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "stamp",
      args: () => ({ caseId: Schema.String, label: Schema.String }),
      returns: () => Schema.Literals(["placeholder", "bigint"]),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "maxAfterPending",
      args: () => ({ caseId: Schema.String }),
      returns: () =>
        Schema.Struct({
          written: Schema.Finite,
          stored: Schema.Literals(["placeholder", "bigint"]),
          value: Schema.String,
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "newestFirst",
      args: () => ({ caseId: Schema.String }),
      returns: () =>
        Schema.Array(
          Schema.Struct({ label: Schema.String, at: CommitTs.CommitTs }),
        ),
    }),
  );
