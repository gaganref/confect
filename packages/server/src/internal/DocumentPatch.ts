import type { ReadonlyValue } from "@confect/core/SchemaToValidator";
import { pipe } from "effect/Function";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as Table from "../Table.js";

export type EncodedPatch = Record.ReadonlyRecord<
  string,
  ReadonlyValue | undefined
>;

export type PatchEncoder = (
  patch: Record.ReadonlyRecord<string, unknown>,
) => Effect.Effect<EncodedPatch, Schema.SchemaError>;

const patchEncoders = new WeakMap<Table.AnyWithProps, PatchEncoder | null>();

/**
 * Returns the encoder for patches to the table's documents, or `undefined` when
 * the table's codec does not encode each field independently. The encoder maps
 * every patched field of the table to its encoded value, or to `undefined` when
 * the patch unsets the field or the field's codec encodes the value as an
 * absent key. Keys outside the table's fields are left out.
 */
export const encoder = (
  table: Table.AnyWithProps,
): PatchEncoder | undefined => {
  let cached = patchEncoders.get(table);
  if (cached === undefined) {
    cached = makePatchEncoder(table);
    patchEncoders.set(table, cached);
  }
  return cached ?? undefined;
};

// A struct with no encoding of its own encodes each field through that field's
// codec alone, so a patch encodes field by field. A union or a transformation
// over the whole struct can make one field's encoding depend on another field.
// A struct-level check must see the decoded fields before they are encoded,
// and keys under an index signature have no field codec of their own.
const makePatchEncoder = (table: Table.AnyWithProps): PatchEncoder | null => {
  const ast = table.Fields.ast;
  if (
    !SchemaAST.isObjects(ast) ||
    ast.encoding !== undefined ||
    ast.checks !== undefined ||
    ast.indexSignatures.length > 0
  ) {
    return null;
  }
  // A field's codec runs only when the patch gives the field a value, since a
  // codec can handle a missing key. Each comes from the table, whose codecs
  // need no services.
  const fieldEncoders: Record.ReadonlyRecord<
    string,
    (
      value: unknown,
    ) => Effect.Effect<ReadonlyValue | undefined, Schema.SchemaError>
  > = Object.fromEntries(
    ast.propertySignatures.map(({ name, type }) => {
      const key = String(name);
      const encode = Schema.encodeUnknownEffect(
        Schema.Struct({
          [key]: Schema.optionalKey(
            Schema.make<Schema.Codec<unknown, ReadonlyValue>>(type),
          ),
        }),
      );
      return [
        key,
        (value: unknown) =>
          Effect.map(encode({ [key]: value }), (encoded) => encoded[key]),
      ];
    }),
  );
  return (patch) =>
    pipe(
      fieldEncoders,
      Record.filter((_, name) => Object.hasOwn(patch, name)),
      Record.map((encode, name) =>
        patch[name] === undefined ? Effect.undefined : encode(patch[name]),
      ),
      Effect.all,
    );
};
