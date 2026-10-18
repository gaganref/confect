import { FunctionSpec, GenericId, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id, scope } from "./_generated/id";
import counters from "./_generated/tables/counters";

export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  id: Id("counters"),
  run: Schema.String,
}) {}

export const StorageId = GenericId.GenericId("_storage", scope);
export const ScheduledId = GenericId.GenericId("_scheduled_functions", scope);

export const Environment = Schema.Struct({
  required: Schema.String,
  directRequired: Schema.String,
  optional: Schema.String,
  marker: Schema.String,
  unbound: Schema.String,
  hostOnly: Schema.String,
});

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "create",
      args: () => ({ run: Schema.String, count: Schema.FiniteFromString }),
      returns: () => Id("counters"),
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "createInternal",
      args: () => ({ run: Schema.String, count: Schema.FiniteFromString }),
      returns: () => Id("counters"),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "list",
      args: () => ({ run: Schema.String }),
      returns: () => Schema.Array(counters.Doc),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "reject",
      args: () => ({ run: Schema.String }),
      error: () => Rejected,
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "schedule",
      args: () => ({ run: Schema.String, count: Schema.FiniteFromString }),
      returns: () => ScheduledId,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "scheduleAndCancel",
      args: () => ({ run: Schema.String }),
      returns: () =>
        Schema.Struct({
          after: ScheduledId,
          at: ScheduledId,
          control: ScheduledId,
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
    FunctionSpec.publicMutation({
      name: "uploadUrl",
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "storageUrl",
      args: () => ({ id: StorageId }),
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
    FunctionSpec.publicQuery({
      name: "location",
      returns: () => Schema.String,
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
          page: Schema.Array(counters.Doc),
          continueCursor: Schema.String,
          isDone: Schema.Boolean,
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "environment",
      returns: () => Environment,
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({ name: "tick", returns: () => Schema.Null }),
  )
  .addFunction(
    FunctionSpec.publicQuery({ name: "ticks", returns: () => Schema.Int }),
  );
