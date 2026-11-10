import type * as IdScope from "@confect/core/IdScope";
import type {
  GenericDocument,
  GenericFieldPaths,
  GenericTableIndexes,
  GenericTableSearchIndexes,
  GenericTableVectorIndexes,
  IdField,
  SystemFields,
  SystemIndexes,
} from "convex/server";
import type { GenericValidator } from "convex/values";
import type { Schema, Types } from "effect";
import type { WithSystemFields } from "@confect/core/SystemFields";
import type * as Document_ from "./Document.js";
import type * as Table from "./Table.js";

export declare const TypeId: "~@confect/server/TableInfo";
export type TypeId = typeof TypeId;

// Read through Table's extractors, not `infer`: an intersection with a Table,
// or an interface extending one, matches `Table<infer ...>` only structurally,
// which widens the name and scope. `Indexes` stays inferred: a generic table's
// index names resolve only through the inferred type's constraint.
export type TableInfo<Table_ extends Table.AnyWithProps> =
  Table_ extends Table.Table<any, any, any, infer Indexes, any, any, any, any>
    ? {
        readonly [TypeId]: TypeId;
        readonly document: WithSystemFields<
          Table.Name<Table_>,
          Schema.Schema.Type<Table.TableSchema<Table_>>,
          Table.Scope<Table_>
        >;
        readonly encodedDocument: WithSystemFields<
          Table.Name<Table_>,
          Schema.Codec.Encoded<Table.TableSchema<Table_>>,
          Table.Scope<Table_>
        >;
        readonly convexDocument: ExtractConvexDocument<
          Table.Name<Table_>,
          Table.TableValidator<Table_>,
          Table.Scope<Table_>
        >;
        readonly fieldPaths:
          | keyof IdField<Table.Name<Table_>>
          | ExtractFieldPaths<Table.TableValidator<Table_>>;
        readonly indexes: Types.Simplify<Indexes & SystemIndexes>;
        readonly searchIndexes: Table.SearchIndexes<Table_>;
        readonly vectorIndexes: Table.VectorIndexes<Table_>;
      }
    : never;

export interface Any {
  readonly [TypeId]: TypeId;
}

export interface AnyWithProps extends Any {
  readonly document: Document_.Any;
  readonly encodedDocument: Document_.AnyEncoded;
  readonly convexDocument: GenericDocument;
  readonly fieldPaths: GenericFieldPaths;
  readonly indexes: GenericTableIndexes;
  readonly searchIndexes: GenericTableSearchIndexes;
  readonly vectorIndexes: GenericTableVectorIndexes;
}

export type ConvexTableInfo<TableInfo_ extends AnyWithProps> = {
  document: TableInfo_["convexDocument"];
  fieldPaths: TableInfo_["fieldPaths"];
  indexes: TableInfo_["indexes"];
  searchIndexes: TableInfo_["searchIndexes"];
  vectorIndexes: TableInfo_["vectorIndexes"];
};

export type TableSchema<TableInfo_ extends AnyWithProps> = Schema.Codec<
  TableInfo_["document"],
  TableInfo_["encodedDocument"]
>;

export type Document<TableInfo_ extends AnyWithProps> = TableInfo_["document"];

// Vendored types from convex-js, partially modified.
// See https://github.com/get-convex/convex-js/pull/14

type ExtractFieldPaths<TableValidator extends GenericValidator> =
  | TableValidator["fieldPaths"]
  | keyof SystemFields;

type ExtractConvexDocument<
  TableName extends string,
  TableValidator extends GenericValidator,
  Scope extends IdScope.IdScope = IdScope.App,
> =
  WithSystemFields<
    TableName,
    TableValidator["type"],
    Scope
  > extends GenericDocument
    ? WithSystemFields<TableName, TableValidator["type"], Scope>
    : never;

// End of vendored types from convex-js, partially modified.
