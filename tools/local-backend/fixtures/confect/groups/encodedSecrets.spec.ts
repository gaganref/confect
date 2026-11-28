import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

// Sides whose decoded type holds no secret: only a schema in their encoding
// chain does, so the value on the wire is a secret and Confect checks the side
// in Convex's place.
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
const MidChain = Schema.String.pipe(
  Schema.decodeTo(Released, SchemaTransformation.passthrough()),
);

const sides = <const Name extends string>(
  name: Name,
  value: Schema.Codec<any, any>,
) =>
  [
    FunctionSpec.publicMutation({
      name: `${name}Take`,
      args: () => ({ value }),
      returns: () => Schema.Null,
    }),
    FunctionSpec.publicMutation({
      name: `${name}Give`,
      args: () => ({ value }),
      returns: () => Schema.Struct({ extra: Schema.Unknown, value }),
    }),
  ] as const;

const [releasedTake, releasedGive] = sides("released", Released);
const [structTake, structGive] = sides("struct", ReleasedStruct);
const [midChainTake, midChainGive] = sides("midChain", MidChain);

export default GroupSpec.make()
  .addFunction(releasedTake)
  .addFunction(releasedGive)
  .addFunction(structTake)
  .addFunction(structGive)
  .addFunction(midChainTake)
  .addFunction(midChainGive);
