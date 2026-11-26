import { convexToJson, type Value } from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Str from "effect/String";
import * as Json from "../../src/internal/Json";

/**
 * The JSON kind of a stored value. A value of a kind no secret-reaching member
 * stores can only be another member's.
 */
export type Kind = "string" | "number" | "object" | "array" | "null";

/**
 * A decoded value of a member, with the canary each string secret in it holds
 * and the text each number secret in it stores as: its JSON, or the `$float`
 * encoding Convex writes `-0`, `NaN` and the infinities in.
 */
interface Sample {
  readonly decoded: unknown;
  readonly canaries: ReadonlyArray<string>;
  readonly numbers: ReadonlyArray<string>;
}

/**
 * A union member shape, with the JSON kinds its stored values have and its
 * decoded values, each holding `canary` wherever it has a secret.
 */
export interface Member {
  readonly name: string;
  readonly schema: Schema.Codec<any, any>;
  readonly secret: boolean;
  readonly kinds: ReadonlyArray<Kind>;
  readonly samples: (canary: string) => ReadonlyArray<Sample>;
}

const numberText = (n: number): string => {
  const json = convexToJson(n);
  return typeof json === "number"
    ? `${json}`
    : (json as { $float: string }).$float;
};

const S = Schema;
const secret = S.RedactedFromValue;
const record = S.Struct({ token: S.String });
const nested = S.Struct({ token: secret(S.String) });
const nonEmpty = S.makeFilter(
  (token: Redacted.Redacted<string>) => Redacted.value(token).length > 0,
);

// An empty struct accepts any value but `null` and `undefined`, so its field
// may store a string.
const besideEmpty = S.Struct({ meta: S.Struct({}), token: secret(S.String) });

/**
 * A secret whose stored form is an empty struct's, so it may store any value
 * but `null`. This one stores its string.
 */
export const throughEmpty = S.Struct({}).pipe(
  S.decodeTo(
    S.Redacted(S.String),
    SchemaTransformation.transform<
      Redacted.Redacted<string>,
      NonNullable<unknown>
    >({
      decode: (stored) =>
        Redacted.make(
          typeof stored === "string" ? stored : Json.stringify(stored),
        ),
      encode: (token) => Redacted.value(token),
    }),
  ),
);

/**
 * A case's own text for a field beside its canary, so no other case's secret
 * holds it.
 */
const metaOf = (canary: string): string =>
  pipe(canary, Str.replace("canary", "meta"));

/**
 * A class with a secret field beside a plain one.
 */
export class Account extends S.Class<
  Account,
  { readonly brand: unique symbol }
>("Account")({
  token: secret(S.String),
  reason: S.String,
}) {}

const holding = (
  decoded: unknown,
  ...canaries: ReadonlyArray<string>
): Sample => ({ decoded, canaries, numbers: [] });
const text = (canary: string): ReadonlyArray<Sample> => [
  holding(Redacted.make(canary), canary),
];
const numbers = (values: ReadonlyArray<number>): ReadonlyArray<Sample> =>
  Arr.map(values, (n) => ({
    decoded: Redacted.make(n),
    canaries: [],
    numbers: [numberText(n)],
  }));
const plain = (values: ReadonlyArray<unknown>): ReadonlyArray<Sample> =>
  Arr.map(values, (decoded) => holding(decoded));

export const members: ReadonlyArray<Member> = [
  {
    name: "a bare secret",
    schema: secret(S.String),
    secret: true,
    kinds: ["string"],
    samples: text,
  },
  {
    name: "a checked secret",
    schema: secret(S.String).check(nonEmpty),
    secret: true,
    kinds: ["string"],
    samples: text,
  },
  {
    name: "a branded secret",
    schema: secret(S.String).pipe(S.brand("ApiKey")),
    secret: true,
    kinds: ["string"],
    samples: text,
  },
  {
    name: "a secret of a JSON string",
    schema: secret(S.fromJsonString(record)),
    secret: true,
    kinds: ["string"],
    samples: (c) => [holding(Redacted.make({ token: c }), c)],
  },
  {
    name: "a secret of a flipped JSON string",
    schema: secret(S.flip(S.fromJsonString(record))),
    secret: true,
    kinds: ["object"],
    samples: (c) => [holding(Redacted.make(Json.stringify({ token: c })), c)],
  },
  {
    name: "a secret of a literal decoded to a number",
    // oxlint-disable-next-line effecttsgo/schema-number -- A number's encoding is the subject.
    schema: secret(S.Literal(0).pipe(S.decodeTo(S.Number))),
    secret: true,
    kinds: ["number"],
    samples: () => numbers([0, -0]),
  },
  {
    name: "a secret number",
    // oxlint-disable-next-line effecttsgo/schema-number -- Its non-finite values are samples.
    schema: secret(S.Number),
    secret: true,
    kinds: ["number"],
    samples: () => numbers([-0, Number.NaN, Infinity, -Infinity, 1234.5678]),
  },
  {
    name: "a struct with a secret",
    schema: nested,
    secret: true,
    kinds: ["object"],
    samples: (c) => [holding({ token: Redacted.make(c) }, c)],
  },
  {
    name: "a struct with a renamed secret",
    schema: nested.pipe(S.encodeKeys({ token: "api_key" })),
    secret: true,
    kinds: ["object"],
    samples: (c) => [holding({ token: Redacted.make(c) }, c)],
  },
  {
    name: "a JSON string of a struct with a secret",
    schema: S.fromJsonString(nested),
    secret: true,
    kinds: ["string"],
    samples: (c) => [holding({ token: Redacted.make(c) }, c)],
  },
  {
    name: "a nullable secret",
    schema: S.NullOr(secret(S.String)),
    secret: true,
    kinds: ["string", "null"],
    samples: (c) => [...text(c), holding(null)],
  },
  {
    name: "an optional-key secret",
    schema: S.Struct({ token: S.optionalKey(secret(S.String)) }),
    secret: true,
    kinds: ["object"],
    samples: (c) => [holding({ token: Redacted.make(c) }, c), holding({})],
  },
  {
    name: "an array of secrets",
    schema: S.Array(secret(S.String)),
    secret: true,
    kinds: ["array"],
    samples: (c) => [
      holding(
        [Redacted.make(`${c}-first`), Redacted.make(`${c}-second`)],
        `${c}-first`,
        `${c}-second`,
      ),
    ],
  },
  {
    name: "a struct with an empty struct beside a secret",
    schema: besideEmpty,
    secret: true,
    kinds: ["object"],
    samples: (c) => [
      holding({ meta: metaOf(c), token: Redacted.make(c) }, c),
      holding({ meta: {}, token: Redacted.make(c) }, c),
    ],
  },
  {
    name: "a secret stored through an empty struct",
    schema: throughEmpty,
    secret: true,
    kinds: ["string", "number", "object", "array"],
    samples: text,
  },
  {
    name: "a class with a secret",
    schema: Account,
    secret: true,
    kinds: ["object"],
    samples: (c) => [
      holding(Account.make({ token: Redacted.make(c), reason: "plain" }), c),
    ],
  },
  {
    name: "an option of a struct with a secret",
    schema: S.OptionFromNullOr(nested),
    secret: true,
    kinds: ["object", "null"],
    samples: (c) => [
      holding(Option.some({ token: Redacted.make(c) }), c),
      holding(Option.none()),
    ],
  },
  {
    name: "a string",
    schema: S.String,
    secret: false,
    kinds: ["string"],
    samples: (c) => plain([c]),
  },
  {
    name: "a number",
    // oxlint-disable-next-line effecttsgo/schema-number -- Its non-finite values are samples.
    schema: S.Number,
    secret: false,
    kinds: ["number"],
    samples: () => plain([-0, Number.NaN, Infinity, -Infinity, 42]),
  },
  {
    name: "a struct of a secret's stored shape",
    schema: record,
    secret: false,
    kinds: ["object"],
    samples: (c) => plain([{ token: c }]),
  },
  {
    name: "a struct of two strings",
    schema: S.Struct({ meta: S.String, token: S.String }),
    secret: false,
    kinds: ["object"],
    samples: (c) => plain([{ meta: metaOf(c), token: c }]),
  },
  {
    name: "a checked option of a string",
    schema: S.OptionFromNullOr(S.String).check(S.makeFilter(() => true)),
    secret: false,
    kinds: ["string", "null"],
    samples: (c) => plain([Option.some(c), Option.none()]),
  },
];

/**
 * A field schema and a member's sample, which a test encodes with the field's
 * own codec to get the value it stores.
 */
export interface Case extends Sample {
  readonly name: string;
  readonly field: Schema.Codec<any, any>;
  /**
   * Whether no secret-reaching member of the field stores a value of `stored`'s
   * JSON kind, so that `stored` must reach every artifact as it is.
   */
  readonly visible: (stored: Value) => boolean;
}

const kindOf = (json: unknown): Kind =>
  json === null
    ? "null"
    : Arr.isArray(json)
      ? "array"
      : typeof json === "string"
        ? "string"
        : typeof json === "number" || "$float" in (json as object)
          ? "number"
          : "object";

/**
 * Every member alone, and every ordered pair of distinct members.
 */
const unions: ReadonlyArray<ReadonlyArray<Member>> = [
  ...Arr.map(members, (member) => [member]),
  ...Arr.flatMap(members, (a) =>
    Arr.map(
      Arr.filter(members, (b) => b !== a),
      (b) => [a, b],
    ),
  ),
];

/**
 * Each union with every sample of each of its members. Each case's canary is
 * its own, none is a prefix of another's, and each holds characters JSON
 * escapes or may escape: a quote, a backslash and a non-ASCII letter.
 */
export const cases: ReadonlyArray<Case> = Arr.flatMap(unions, (union, u) => {
  const field =
    union.length === 1
      ? union[0]!.schema
      : S.Union(Arr.map(union, (m) => m.schema));
  const name = Arr.join(
    Arr.map(union, (m) => m.name),
    " or ",
  );
  const visible = (stored: Value) => {
    const kind = kindOf(convexToJson(stored));
    return !Arr.some(
      union,
      (other) => other.secret && Arr.contains(other.kinds, kind),
    );
  };
  return Arr.flatMap(union, (member, m) =>
    Arr.map(member.samples(`canary-${u}-${m}-"\\é`), (sample, s) => ({
      ...sample,
      name: `${name}, ${member.name} sample ${s}`,
      field,
      visible,
    })),
  );
});

const escaped = (raw: string): string =>
  pipe(Json.stringify(raw), Str.slice(1, -1));

/**
 * Every form `canary` can take in an artifact: itself, escaped once as a JSON
 * string holds it, escaped again as a JSON string inside JSON holds it, and
 * with its `é` as a `\u` escape.
 */
export const textForms = (canary: string): ReadonlyArray<string> => [
  canary,
  escaped(canary),
  escaped(escaped(canary)),
  pipe(canary, Str.replaceAll("é", "\\u00e9")),
];
