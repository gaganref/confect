import { ActionCall, Callback, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "./_generated/id";
import { EventRejected, OnBatch, OnEvent, OnSample, Status } from "./callbacks";

export const Outcome = Schema.Literals(["success", "failure", "defect"]);

// Optional keys, a bigint, bytes and a record, so the parity test compares
// those forms in args and returns with Convex's.
const Sample = {
  note: Schema.optional(Schema.String),
  label: Schema.optionalKey(Schema.String),
  count: Schema.BigInt,
  bytes: Schema.instanceOf(ArrayBuffer),
  tally: Schema.Record(Schema.String, Schema.BigInt),
  onSample: Schema.optional(Callback.handle(OnSample)),
};

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "storeMalformed",
      args: () => ({ run: Schema.String }),
      returns: () => Id("deliveries"),
    }),
  )
  .addFunction(
    ActionCall.profile.publicAction({
      name: "notify",
      args: () => ({ run: Schema.String, onEvent: Callback.handle(OnEvent) }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    }),
  )
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
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "echoBatch",
      args: () => ({ onBatch: Callback.handle(OnBatch) }),
      returns: () => Callback.handle(OnBatch),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "echoSample",
      args: () => Sample,
      returns: () => Schema.Struct(Sample),
    }),
  );
