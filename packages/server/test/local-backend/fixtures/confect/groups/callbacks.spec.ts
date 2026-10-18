import { Component, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import {
  EventRejected,
  Status,
} from "../../components/counter/confect/callbacks";
import { Outcome } from "../../components/counter/confect/deliveries.spec";
import { first } from "../componentBindings";

const DeliveryId = () => Component.id(first, "deliveries");

const Observation = Schema.Struct({
  outcome: Outcome,
  message: Schema.String,
});

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.internalMutation({
      name: "onEvent",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "send",
      args: () => ({ run: Schema.String }),
      returns: DeliveryId,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "setStatus",
      args: () => ({ id: DeliveryId(), status: Status }),
      returns: () => Schema.NullOr(Schema.String),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "breach",
      args: () => ({ id: DeliveryId() }),
      returns: () => Outcome,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "sameHandle",
      args: () => ({ id: DeliveryId() }),
      returns: () => Schema.Boolean,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "createRetired",
      returns: () => Observation,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "createMismatched",
      returns: () => Observation,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "get",
      args: () => ({ id: DeliveryId() }),
      returns: () => Schema.Struct({ run: Schema.String, status: Status }),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "events",
      args: () => ({ run: Schema.String }),
      returns: () => Schema.Array(Status),
    }),
  );
