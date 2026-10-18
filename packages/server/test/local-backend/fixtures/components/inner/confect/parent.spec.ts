import { Component, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import counters from "../../counter/confect/_generated/tables/counters";
import { child } from "./child";

export const counterId = () => Component.id(child, "counters");
export const counterDoc = () => Component.schema(child, counters.Doc);

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "create",
      args: () => ({ run: Schema.String, count: Schema.FiniteFromString }),
      returns: counterId,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "list",
      args: () => ({ run: Schema.String }),
      returns: () => Schema.Array(counterDoc()),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "location",
      returns: () => Schema.String,
    }),
  );
