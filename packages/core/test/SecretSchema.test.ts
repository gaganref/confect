import { SecretSchema } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

const secret = Schema.RedactedFromValue(Schema.String);

interface Tree {
  readonly label: string;
  readonly children: ReadonlyArray<Tree>;
}
const Tree: Schema.Codec<Tree> = Schema.Struct({
  label: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
});

interface Vault {
  readonly key: ReadonlyArray<unknown>;
  readonly inner: ReadonlyArray<Vault>;
}
const Vault: Schema.Codec<Vault, any> = Schema.Struct({
  key: Schema.Array(secret),
  inner: Schema.Array(Schema.suspend((): Schema.Codec<Vault, any> => Vault)),
});

describe("SecretSchema.hasSecret", () => {
  it.each([
    ["a bare secret", secret],
    ["an option", Schema.OptionFromNullOr(secret)],
    ["a union member", Schema.Union([Schema.Finite, secret])],
    ["an array element", Schema.Array(secret)],
    ["a tuple element", Schema.Tuple([Schema.String, secret])],
    ["a record value", Schema.Record(Schema.String, secret)],
    ["a struct field", Schema.Struct({ token: secret })],
    [
      "a suspended schema",
      Schema.suspend(() => Schema.Struct({ token: secret })),
    ],
    ["a recursive schema", Vault],
    [
      "a declaration nested in a declaration",
      secret.pipe(
        Schema.OptionFromNullOr,
        Schema.Array,
        Schema.OptionFromNullOr,
      ),
    ],
  ])("finds a secret in %s", (_, schema) => {
    expect(SecretSchema.hasSecret(schema.ast)).toBe(true);
  });

  it.each([
    ["a string", Schema.String],
    ["an option of a string", Schema.OptionFromNullOr(Schema.String)],
    ["a recursive schema without one", Tree],
  ])("finds none in %s", (_, schema) => {
    expect(SecretSchema.hasSecret(schema.ast)).toBe(false);
  });
});
