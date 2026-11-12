import { FunctionSpec } from "@confect/core";
import * as Schema from "effect/Schema";

export const profile = FunctionSpec.extend()({
  middleware: [],
  reservedArgument: "context",
});
export const args = () => ({ run: Schema.String });
export const snapshot = () =>
  Schema.Struct({
    args: Schema.Struct(args()),
    received: Schema.Struct({
      value: Schema.Unknown,
      requestId: Schema.String,
      deployment: Schema.NullOr(Schema.String),
    }),
  });
