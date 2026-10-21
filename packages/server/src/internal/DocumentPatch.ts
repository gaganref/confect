import type { ReadonlyValue } from "@confect/core/SchemaToValidator";
import { pipe } from "effect/Function";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Document from "../Document.js";
import type * as Table from "../Table.js";

export type EncodedPatch = Record.ReadonlyRecord<
  string,
  ReadonlyValue | undefined
>;

export type PatchEncoder = (
  patch: Record.ReadonlyRecord<string, unknown>,
  id: string,
) => Effect.Effect<EncodedPatch, Document.DocumentEncodeError>;

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
// codec alone, so a patch encodes as the same struct with every key optional.
// A union or a transformation over the whole struct can make one field's
// encoding depend on another field.
const makePatchEncoder = (table: Table.AnyWithProps): PatchEncoder | null => {
  const ast = table.Fields.ast;
  if (!SchemaAST.isObjects(ast) || ast.encoding !== undefined) {
    return null;
  }
  const fieldNames = new Set(ast.propertySignatures.map(({ name }) => name));
  // Each field's codec comes from the table, whose codecs need no services.
  const encode = Schema.encodeUnknownEffect(
    Schema.Struct(
      Object.fromEntries(
        ast.propertySignatures.map(({ name, type }) => [
          name,
          Schema.optionalKey(
            Schema.make<Schema.Codec<unknown, ReadonlyValue>>(type),
          ),
        ]),
      ),
    ),
  );
  return (patch, id) =>
    pipe(
      Record.filter(patch, Predicate.isNotUndefined),
      encode,
      Effect.map((encoded) =>
        Record.map(
          Record.filter(patch, (_, key) => fieldNames.has(key)),
          (_, key) => encoded[key],
        ),
      ),
      Effect.catchIf(Schema.isSchemaError, (schemaError) =>
        Effect.fail(
          new Document.DocumentEncodeError({
            tableName: table.tableName,
            id,
            parseError: schemaError.message,
          }),
        ),
      ),
    );
};
