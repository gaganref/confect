import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "../_generated/id";

// Pairs of public mutations that differ only in whether `value` is a secret.
// Convex checks the plain twin's sides, and Confect checks the secret twin's in
// Convex's place. The suite sends both the same calls and compares the answers.
const Plain = Schema.String;
const Secret = Schema.RedactedFromValue(Schema.String);

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "countPlain",
      args: () => ({ value: Plain }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "countSecret",
      args: () => ({ value: Secret }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "idPlain",
      args: () => ({ row: Id("transactionNotes"), value: Plain }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "idSecret",
      args: () => ({ row: Id("transactionNotes"), value: Secret }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "toStringPlain",
      returns: () =>
        Schema.Struct({
          toString: Schema.optionalKey(Schema.String),
          value: Plain,
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "toStringSecret",
      returns: () =>
        Schema.Struct({
          toString: Schema.optionalKey(Schema.String),
          value: Secret,
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "pendingPlain",
      returns: () => Schema.Struct({ ts: Schema.Unknown, value: Plain }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "pendingSecret",
      returns: () => Schema.Struct({ ts: Schema.Unknown, value: Secret }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "datePlain",
      args: () => ({ value: Plain }),
      returns: () => Schema.Struct({ extra: Schema.Unknown, value: Plain }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "dateSecret",
      args: () => ({ value: Secret }),
      returns: () => Schema.Struct({ extra: Schema.Unknown, value: Secret }),
    }),
  );
