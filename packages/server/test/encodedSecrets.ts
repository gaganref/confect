/**
 * Schemas whose decoded type holds no secret: only a schema in their encoding
 * chain does, so the value on the wire is a secret. Each comes with a wire
 * value that holds `marker` and the decoded value a handler returns for it.
 */
import * as Arr from "effect/Array";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const Secret = Schema.RedactedFromValue(Schema.String);

const release = SchemaTransformation.transform({
  decode: Redacted.value<string>,
  encode: (value: string) => Redacted.make(value),
});

const Released = Secret.pipe(Schema.decodeTo(Schema.String, release));

const ReleasedStruct = Schema.Struct({ token: Secret }).pipe(
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
const MidChain = Schema.String.pipe(
  Schema.decodeTo(Released, SchemaTransformation.passthrough()),
);

export interface Shape {
  readonly name: string;
  readonly schema: Schema.Codec<any, any>;
  readonly wire: (marker: string) => unknown;
}

/**
 * The shapes a function side can take: each encodes to what Convex stores.
 */
export const shapes = (): ReadonlyArray<Shape> => [
  { name: "a secret decoded into a string", schema: Released, wire: (m) => m },
  {
    name: "a struct holding one decoded into another struct",
    schema: ReleasedStruct,
    wire: (m) => ({ token: m }),
  },
  {
    name: "a secret in the middle of an encoding chain",
    schema: MidChain,
    wire: (m) => m,
  },
];

/**
 * With a flipped secret, whose encoded side is the `Redacted` value itself, for
 * the checks that read only the schema.
 */
export const schemaShapes = (): ReadonlyArray<
  readonly [string, Schema.Codec<any, any>]
> => [
  ...Arr.map(shapes(), ({ name, schema }) => [name, schema] as const),
  ["a flipped secret", Schema.flip(Secret)],
];
