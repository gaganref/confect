import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

const number = { returns: () => Schema.Finite };

export default GroupSpec.make()
  .addFunction(FunctionSpec.publicQuery({ name: "version", ...number }))
  .addFunction(FunctionSpec.publicQuery({ name: "checkRuns", ...number }))
  .addFunction(FunctionSpec.internalQuery({ name: "internalRuns", ...number }))
  .addFunction(FunctionSpec.publicMutation({ name: "touch", ...number }))
  .addFunction(
    FunctionSpec.internalMutation({ name: "internalTouch", ...number }),
  )
  .addFunction(FunctionSpec.publicAction({ name: "act", ...number }))
  .addFunction(FunctionSpec.internalAction({ name: "internalAct", ...number }))
  .addFunction(
    FunctionSpec.publicQuery({ name: "componentVersion", ...number }),
  )
  .addFunction(
    FunctionSpec.publicQuery({ name: "componentCheckRuns", ...number }),
  );
