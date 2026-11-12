import { Component, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Environment } from "../../components/counter/confect/counter.spec";
import { first } from "../componentBindings";

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "exercise",
      args: () => ({ run: Schema.String }),
      returns: () =>
        Schema.Struct({
          first: Schema.Array(Schema.Finite),
          second: Schema.Array(Schema.Finite),
          left: Schema.Array(Schema.Finite),
          right: Schema.Array(Schema.Finite),
          rejectedId: Component.id(first, "counters"),
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "schedule",
      args: () => ({ run: Schema.String }),
      returns: () => Component.id(first, "_scheduled_functions"),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "scheduleAndCancel",
      args: () => ({ run: Schema.String }),
      returns: () =>
        Schema.Struct({
          after: Component.id(first, "_scheduled_functions"),
          at: Component.id(first, "_scheduled_functions"),
          control: Component.id(first, "_scheduled_functions"),
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "cancel",
      args: () => ({ id: Schema.String }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "list",
      args: () => ({ run: Schema.String }),
      returns: () =>
        Schema.Struct({
          first: Schema.Array(Schema.Finite),
          second: Schema.Array(Schema.Finite),
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "uploadUrl",
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "storageUrl",
      args: () => ({ id: Component.id(first, "_storage") }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "hasAuth",
      returns: () => Schema.Boolean,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "deepCreate",
      args: () => ({
        run: Schema.String,
        installation: Schema.Literals(["left", "right"]),
        count: Schema.Finite,
      }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "deepRead",
      args: () => ({
        run: Schema.String,
        installation: Schema.Literals(["left", "right"]),
      }),
      returns: () =>
        Schema.Struct({
          counts: Schema.Array(Schema.Finite),
          path: Schema.String,
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "declaredError",
      args: () => ({ run: Schema.String }),
      returns: () =>
        Schema.Struct({
          tag: Schema.Literal("Rejected"),
          run: Schema.String,
          instance: Schema.Boolean,
          remaining: Schema.Array(Schema.Finite),
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "seed",
      args: () => ({ run: Schema.String, counts: Schema.Array(Schema.Finite) }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "page",
      args: () => ({
        run: Schema.String,
        cursor: Schema.NullOr(Schema.String),
        numItems: Schema.Int,
      }),
      returns: () =>
        Schema.Struct({
          page: Schema.Array(Schema.Finite),
          continueCursor: Schema.String,
          isDone: Schema.Boolean,
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "environment",
      returns: () =>
        Schema.Struct({
          first: Environment,
          second: Environment,
          host: Schema.Struct({
            marker: Schema.String,
            hostOnly: Schema.String,
          }),
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "ticks",
      returns: () => Schema.Struct({ first: Schema.Int, second: Schema.Int }),
    }),
  );
