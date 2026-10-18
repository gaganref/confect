import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

export default GroupSpec.makeNode().addFunction(
  FunctionSpec.publicNodeAction({
    name: "run",
    returns: () => Schema.String,
  }),
);
