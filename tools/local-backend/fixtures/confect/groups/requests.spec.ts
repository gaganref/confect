import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

/**
 * What a function reads of its request: `ctx.meta.getRequestMetadata()` and the
 * subject of `ctx.auth.getUserIdentity()`.
 */
export const Reading = Schema.Struct({
  requestId: Schema.String,
  ip: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  scheduledFunctionId: Schema.NullOr(Schema.String),
  authToken: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
});

/**
 * A scheduled function's reading, and its nested mutation's when it is an
 * action, as it records them for the test to read.
 */
export const Recorded = Schema.Struct({
  label: Schema.Literals(["mutation", "action"]),
  own: Reading,
  nested: Schema.NullOr(Reading),
});

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "mutation",
      returns: () => Schema.Struct({ own: Reading, nested: Reading }),
    }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "action",
      returns: () =>
        Schema.Struct({ own: Reading, mutation: Reading, action: Reading }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "schedule",
      args: () => ({ caseId: Schema.String }),
      returns: () =>
        Schema.Struct({
          own: Reading,
          mutationJob: Schema.String,
          actionJob: Schema.String,
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "recorded",
      args: () => ({ caseId: Schema.String }),
      returns: () => Schema.Array(Schema.String),
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "read",
      returns: () => Reading,
    }),
  )
  .addFunction(
    FunctionSpec.internalAction({
      name: "readAction",
      returns: () => Reading,
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "scheduledMutation",
      args: () => ({ caseId: Schema.String }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.internalAction({
      name: "scheduledAction",
      args: () => ({ caseId: Schema.String }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "record",
      args: () => ({ caseId: Schema.String, value: Schema.String }),
      returns: () => Schema.Null,
    }),
  );
