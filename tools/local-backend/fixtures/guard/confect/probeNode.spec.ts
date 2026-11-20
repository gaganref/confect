import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

const number = { returns: () => Schema.Finite };

export default GroupSpec.makeNode()
  .addFunction(FunctionSpec.publicNodeAction({ name: "version", ...number }))
  .addFunction(FunctionSpec.publicNodeAction({ name: "checkRuns", ...number }))
  .addFunction(
    FunctionSpec.internalNodeAction({ name: "internalRuns", ...number }),
  );
