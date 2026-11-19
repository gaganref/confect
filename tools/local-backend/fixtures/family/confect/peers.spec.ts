import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

export default GroupSpec.make().addFunction(
  FunctionSpec.publicQuery({
    name: "read",
    returns: () =>
      Schema.Struct({
        peers: Schema.Array(Schema.String),
        caller: Schema.NullOr(Schema.String),
      }),
  }),
);
