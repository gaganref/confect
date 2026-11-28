import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "../_generated/id";

// Pairs of public mutations that differ only in whether `value` is a secret.
// Convex checks the plain twin's sides, and Confect checks the secret twin's in
// Convex's place. The suite sends both the same calls and compares the answers.
const Plain = Schema.String;
const Secret = Schema.RedactedFromValue(Schema.String);
// A check whose message writes the value it refuses, as a product's own may.
const Token = Schema.String.check(
  Schema.makeFilter(
    (token: string) => token.length < 8 || `token too long: ${token}`,
  ),
);
const Payload = Schema.Struct({ token: Token }).pipe(Schema.fromJsonString);

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
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "tokenPlain",
      args: () => ({ payload: Payload }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "tokenSecret",
      args: () => ({ payload: Payload.pipe(Schema.RedactedFromValue) }),
      returns: () => Schema.Null,
    }),
  );
