import { Component, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import {
  counterId as childId,
  counterDoc as childDoc,
} from "../../inner/confect/parent.spec";
import { child } from "./child";

export const counterId = () => Component.schema(child, childId());
export const counterDoc = () => Component.schema(child, childDoc());

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
