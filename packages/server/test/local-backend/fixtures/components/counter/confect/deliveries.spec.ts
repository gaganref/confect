import { Callback, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "./_generated/id";
import { OnEvent, Status } from "./callbacks";

export const Outcome = Schema.Literals(["success", "failure", "defect"]);

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "send",
      args: () => ({ run: Schema.String, onEvent: Callback.handle(OnEvent) }),
      returns: () => Id("deliveries"),
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "deliver",
      args: () => ({ id: Id("deliveries") }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "setStatus",
      args: () => ({ id: Id("deliveries"), status: Status }),
      returns: () => Schema.NullOr(Schema.String),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "breach",
      args: () => ({ id: Id("deliveries") }),
      returns: () => Outcome,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "get",
      args: () => ({ id: Id("deliveries") }),
      returns: () =>
        Schema.Struct({
          run: Schema.String,
          status: Status,
          onEvent: Callback.handle(OnEvent),
        }),
    }),
  );
