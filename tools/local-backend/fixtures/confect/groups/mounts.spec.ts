import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

const Mount = Schema.Literals(["first", "second"]);

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "create",
      args: () => ({ mount: Mount, run: Schema.String, count: Schema.Finite }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "counts",
      args: () => ({ mount: Mount, run: Schema.String }),
      returns: () => Schema.Array(Schema.Finite),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "replaced",
      args: () => ({ run: Schema.String }),
      returns: () =>
        Schema.Struct({
          inside: Schema.Array(Schema.Finite),
          outside: Schema.Array(Schema.Finite),
        }),
    }),
  );
