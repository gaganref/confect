import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

const Timer = Schema.Literals(["setTimeout", "setInterval"]);

// What a rejected fetch tells its handler.
const Rejection = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
});

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicQuery({
      name: "fetchInQuery",
      args: () => ({ url: Schema.String }),
      returns: () => Rejection,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "fetchInMutation",
      args: () => ({ url: Schema.String }),
      returns: () => Rejection,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "timerInQuery",
      args: () => ({ name: Timer }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "timerInMutation",
      args: () => ({ name: Timer }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "immediateInQuery",
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "clearInQuery",
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "fetchInAction",
      args: () => ({ url: Schema.String }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "timersInAction",
      returns: () => Schema.Array(Schema.String),
    }),
  );
