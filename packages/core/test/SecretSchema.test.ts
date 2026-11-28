import { SecretSchema } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";

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

// Shapes whose decoded type holds no secret: only a schema in their encoding
// chain does, so the value on the wire is a secret.
const released = secret.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: Redacted.value,
      encode: (value: string) => Redacted.make(value),
    }),
  ),
);
const releasedStruct = Schema.Struct({ token: secret }).pipe(
  Schema.decodeTo(
    Schema.Struct({ token: Schema.String }),
    SchemaTransformation.transform({
      decode: ({ token }) => ({ token: Redacted.value(token) }),
      encode: ({ token }: { readonly token: string }) => ({
        token: Redacted.make(token),
      }),
    }),
  ),
);
// Two links, with the secret in the first: decoded string, secret, wire string.
const midChain = Schema.String.pipe(
  Schema.decodeTo(released, SchemaTransformation.passthrough()),
);
// Two links, with the secret in the last: decoded string, string, wire secret.
const wireEnd = secret.pipe(
  Schema.decodeTo(
    Schema.String.pipe(
      Schema.decodeTo(Schema.String, SchemaTransformation.passthrough()),
    ),
    SchemaTransformation.transform({
      decode: Redacted.value,
      encode: (value: string) => Redacted.make(value),
    }),
  ),
);

// A suspension whose schema's encoding leads back to it.
interface Looped {
  readonly next?: Looped;
}
const looped = (field: Schema.Struct.Fields): Schema.Codec<Looped, any> => {
  const self: Schema.Codec<Looped, any> = Schema.Struct({
    ...field,
    next: Schema.optionalKey(
      Schema.suspend((): Schema.Codec<Looped, any> => self),
    ),
  }).pipe(
    Schema.decodeTo(
      Schema.Struct({ next: Schema.optionalKey(Schema.Unknown) }),
      SchemaTransformation.passthrough({ strict: false }),
    ),
  ) as never;
  return self;
};

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
    ["a secret decoded into a string", released],
    ["a struct holding one decoded into another struct", releasedStruct],
    ["a secret in the middle of an encoding chain", midChain],
    ["a flipped secret", Schema.flip(secret)],
    ["a secret at the wire end of an encoding chain", wireEnd],
    [
      "a hand-written policy's Schema.Redacted field",
      Schema.Struct({ text: Schema.Redacted(Schema.String) }),
    ],
    ["a field decoded from one", Schema.Struct({ label: released })],
    ["a suspension whose encoding leads back to it", looped({ token: secret })],
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
    [
      "a string decoded from a number",
      Schema.Finite.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: String,
            encode: Number,
          }),
        ),
      ),
    ],
    [
      "a suspension whose encoding leads back to it",
      looped({ label: Schema.String }),
    ],
  ])("finds none in %s", (_, schema) => {
    expect(SecretSchema.hasSecret(schema.ast)).toBe(false);
  });
});

// Recursive schemas whose recursion runs through an encoding Effect derives
// with `toEncoded`, which unfolds into fresh nodes on every level.
const reencoded = <S extends Schema.Top>(self: S) =>
  self.pipe(
    Schema.encode({
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.passthrough(),
    }),
  );
const recEncKeys: Schema.Codec<any, any> = Schema.Struct({
  next: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<any, any> => recEncKeys),
  ),
  label: Schema.String,
}).pipe(Schema.encodeKeys({ label: "lbl" }));
const recEncKeysSecret: Schema.Codec<any, any> = Schema.Struct({
  next: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<any, any> => recEncKeysSecret),
  ),
  token: secret,
}).pipe(Schema.encodeKeys({ token: "secret_token" }));
const recEncoded: Schema.Codec<any, any> = reencoded(
  Schema.Struct({
    next: Schema.optionalKey(
      Schema.suspend((): Schema.Codec<any, any> => recEncoded),
    ),
  }),
);
const recCaught: Schema.Codec<any, any> = Schema.Struct({
  next: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<any, any> => recCaught),
  ),
}).pipe(Schema.catchEncoding(() => Effect.succeedNone));
const recSuspendEncoded: Schema.Codec<any, any> = reencoded(
  Schema.suspend(() =>
    Schema.Struct({ next: Schema.optionalKey(recSuspendEncoded) }),
  ),
);

describe("SecretSchema.hasSecret on a recursion through a derived encoding", () => {
  it.each([
    ["a recursive struct with renamed keys", recEncKeys, false],
    ["a recursive struct with a renamed secret key", recEncKeysSecret, true],
    ["a recursive struct re-encoded", recEncoded, false],
    ["a recursive struct whose encoding is caught", recCaught, false],
    ["a re-encoded suspension of a recursive struct", recSuspendEncoded, false],
  ] as const)(
    "answers for %s without overflowing",
    { timeout: 1000 },
    (_, schema, expected) => {
      expect(SecretSchema.hasSecret(schema.ast)).toBe(expected);
    },
  );

  it(
    "visits fifteen nested encoded suspensions in linear time",
    { timeout: 1000 },
    () => {
      const nested = Arr.reduce(
        Arr.range(1, 15),
        Schema.String as Schema.Codec<any, any>,
        (inner) =>
          reencoded(
            Schema.Struct({
              a: Schema.optionalKey(Schema.suspend(() => inner)),
              b: Schema.optionalKey(Schema.suspend(() => inner)),
            }),
          ),
      );
      expect(SecretSchema.hasSecret(nested.ast)).toBe(false);
    },
  );

  it(
    "fails closed on a flipped recursion through an encoding, which never repeats a node",
    { timeout: 5000 },
    () => {
      expect(SecretSchema.hasSecret(Schema.flip(recEncKeys).ast)).toBe(true);
    },
  );
});

describe("SecretSchema.hasSecret on a record key", () => {
  it.each([
    [
      "a record keyed by a released secret",
      Schema.Record(released, Schema.String),
    ],
    [
      "a record keyed by a union holding one",
      Schema.Record(
        Schema.Union([released, Schema.Literal("a")]),
        Schema.String,
      ),
    ],
    [
      "a struct's rest record keyed by one",
      Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(released, Schema.String),
      ]),
    ],
  ])("finds a secret in %s", (_, schema) => {
    expect(SecretSchema.hasSecret(schema.ast)).toBe(true);
  });

  it("finds none in a record keyed by a plain string", () => {
    expect(
      SecretSchema.hasSecret(Schema.Record(Schema.String, Schema.String).ast),
    ).toBe(false);
  });
});
