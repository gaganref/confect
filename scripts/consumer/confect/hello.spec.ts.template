import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
const wrongArgs: Record<string, typeof Schema.FiniteFromString> = {
  other: Schema.FiniteFromString,
};
export default GroupSpec.make()
  .addFunction(FunctionSpec.publicQuery({ name: "readMarker", returns: () => Schema.String }))
  .addFunction(
    FunctionSpec.publicQuery({ name: "greet", returns: () => Schema.String }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "increment",
      args: () => ({ value: Schema.Finite }),
      returns: () => Schema.Finite,
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "onResult",
      args: () => ({ value: Schema.FiniteFromString }),
      returns: () => Schema.FiniteFromString,
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "wrongArgs",
      args: () => wrongArgs,
      returns: () => Schema.FiniteFromString,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "notify",
      args: () => ({ value: Schema.Finite }),
      returns: () => Schema.Finite,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "checkArgs",
      returns: () => Schema.String,
    }),
  );
