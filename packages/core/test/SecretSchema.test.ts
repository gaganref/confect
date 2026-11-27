import { SecretSchema } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const secret = Schema.RedactedFromValue(Schema.String);

// A check on a schema moves its resolved annotations to the check, so each of
// these keeps the `Redacted` declaration only beneath its check or brand.
const nonEmpty = Schema.makeFilter(
  (token: Redacted.Redacted<string>) => Redacted.value(token).length > 0,
  { description: "a non-empty token" },
);
const checked = secret.check(nonEmpty);
const branded = secret.pipe(Schema.brand("ApiKey"));
const checkedBranded = secret.check(nonEmpty).pipe(Schema.brand("ApiKey"));

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

describe("SecretSchema.isSecretNode", () => {
  it.each([
    ["a bare secret", secret],
    ["a checked secret", checked],
    ["a branded secret", branded],
    ["a checked and branded secret", checkedBranded],
  ])("reads %s as a secret node", (_, schema) => {
    expect(SecretSchema.isSecretNode(schema.ast)).toBe(true);
  });

  it.each([
    ["a checked string", Schema.String.check(Schema.isMinLength(1))],
    [
      "a checked option of a string",
      Schema.OptionFromNullOr(Schema.String).check(
        Schema.makeFilter(() => true),
      ),
    ],
    ["a struct holding a secret", Schema.Struct({ token: secret })],
  ])("does not read %s as a secret node", (_, schema) => {
    expect(SecretSchema.isSecretNode(schema.ast)).toBe(false);
  });
});

describe("SecretSchema.hasSecret", () => {
  it.each([
    ["a bare secret", secret],
    ["a checked secret", checked],
    ["a branded secret", branded],
    ["a checked and branded secret", checkedBranded],
    [
      "a checked secret with a later annotation",
      checked.annotate({ title: "token" }),
    ],
    [
      "a checked Schema.Redacted",
      Schema.Redacted(Schema.String).check(nonEmpty),
    ],
    [
      "a checked struct's field",
      Schema.Struct({ token: checked }).check(
        Schema.makeFilter(() => true, { description: "a checked struct" }),
      ),
    ],
    ["an optional key", Schema.Struct({ token: Schema.optionalKey(checked) })],
    ["an optional field", Schema.Struct({ token: Schema.optional(checked) })],
    ["a checked secret's array", Schema.Array(checkedBranded)],
    ["a checked secret's union", Schema.Union([Schema.Finite, checked])],
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
    ["a checked string", Schema.String.check(Schema.isMinLength(1))],
    ["a branded string", Schema.String.pipe(Schema.brand("ApiKey"))],
    [
      "a checked option of a string",
      Schema.OptionFromNullOr(Schema.String).check(
        Schema.makeFilter(() => true),
      ),
    ],
    [
      "a checked struct without one",
      Schema.Struct({
        label: Schema.String.check(Schema.isMinLength(1)),
      }).check(Schema.makeFilter(() => true)),
    ],
  ])("finds none in %s", (_, schema) => {
    expect(SecretSchema.hasSecret(schema.ast)).toBe(false);
  });
});
