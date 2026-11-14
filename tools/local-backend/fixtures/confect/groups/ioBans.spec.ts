import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

const Timer = Schema.Literals(["setTimeout", "setInterval"]);

// What a rejected fetch tells its handler.
const Rejection = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
});

// What each global the isolate lacks reads as inside a function.
export const Surface = Schema.Struct({
  setImmediate: Schema.String,
  queueMicrotask: Schema.String,
});

export const FormBody = Schema.Literals([
  "multipart",
  "urlencoded",
  "multipartWithoutBoundary",
]);

// A parsed field, or what a rejected formData() tells its handler.
const Parsed = Schema.Union([
  Schema.Struct({ returned: Schema.NullOr(Schema.String) }),
  Rejection,
]);

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
      name: "awaitedTimerInQuery",
      args: () => ({ name: Timer }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "awaitedTimerInMutation",
      args: () => ({ name: Timer }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "surfaceInQuery",
      returns: () => Surface,
    }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "surfaceInAction",
      returns: () => Surface,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "formDataInQuery",
      args: () => ({ body: FormBody }),
      returns: () => Parsed,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "formDataInMutation",
      args: () => ({ body: FormBody }),
      returns: () => Parsed,
    }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "formDataInAction",
      args: () => ({ body: FormBody }),
      returns: () => Parsed,
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
