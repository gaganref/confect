import { FunctionSpec, GroupSpec } from "@confect/core";
import { Surface } from "./groups/ioBans.spec";

export default GroupSpec.makeNode().addFunction(
  FunctionSpec.publicNodeAction({
    name: "surfaceNode",
    returns: () => Surface,
  }),
);
