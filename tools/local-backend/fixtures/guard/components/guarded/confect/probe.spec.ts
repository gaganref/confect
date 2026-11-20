import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicQuery({ name: "version", returns: () => Schema.Finite }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "checkRuns",
      returns: () => Schema.Finite,
    }),
  );
