import type * as IdScope from "@confect/core/IdScope";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { compileTableSchema } from "@confect/core/SchemaToValidator";
import * as Table_ from "@confect/core/Table";
import * as Schema from "effect/Schema";
import { defineTable, type TableDefinition } from "convex/server";

export {
  TypeId,
  isTable,
  isUnnamedTable,
  make,
  type Table,
  type Any,
  type AnyWithProps,
  type UnnamedTable,
  type UnnamedAny,
  type UnnamedAnyWithProps,
  type Name,
  type TableSchema,
  type TableValidator,
  type Indexes,
  type SearchIndexes,
  type VectorIndexes,
  type Doc,
  type Fields,
  type Scope,
  type WithName,
  type TablesRecord,
  TableRefused,
  deployRefusals,
  verifyDeploy,
} from "@confect/core/Table";

// -----------------------------------------------------------------------------
// tableDefinition
// -----------------------------------------------------------------------------
//
// The deploy-time Convex `TableDefinition` is the part of a table that
// belongs on the server: it value-imports `defineTable` from `convex/server`.
// Specs and generated refs reach `Fields`/`Doc` through `@confect/core`,
// so this helper is only called from `_generated/convexSchema.ts`.

const tableDefinitionCache = new WeakMap<
  Table_.AnyWithProps,
  TableDefinition<any, any, any, any>
>();

/**
 * The Convex definition of `table`, its validator and indexes, which a
 * backend's Convex schema passes to `defineSchema`. Every backend's schema is
 * built through it: the generated `_generated/convexSchema.ts` calls it for
 * each table, and a manifest section that sets `wrapsSchema` must too.
 *
 * It first runs the deploy checks `table` carries, which
 * `Table.make(...).deployCheck` added, and throws {@link Table_.TableRefused},
 * naming the table and each refusal, when any refuses it. Convex evaluates the
 * schema module while it analyzes a push, for the app and each component, and
 * never while it serves a call, so a refused table refuses the push and the
 * deployment keeps serving the last push that succeeded. A table that passes is
 * built once, and later calls return that definition without running its checks
 * again.
 */
export const tableDefinition = <Table extends Table_.AnyWithProps>(
  table: Table,
): TableDefinition<
  Table_.TableValidator<Table>,
  Table_.Indexes<Table>,
  Table_.SearchIndexes<Table>,
  Table_.VectorIndexes<Table>
> => {
  const cached = tableDefinitionCache.get(table);
  if (cached !== undefined) {
    return cached as TableDefinition<
      Table_.TableValidator<Table>,
      Table_.Indexes<Table>,
      Table_.SearchIndexes<Table>,
      Table_.VectorIndexes<Table>
    >;
  }

  Result.getOrThrow(Table_.verifyDeploy(table));

  let definition: TableDefinition<any, any, any, any> = defineTable(
    compileTableSchema(table.Fields, table.scope),
  );
  for (const [name, indexFields] of Record.toEntries(
    table.indexes as Record<string, any>,
  )) {
    definition = definition.index(name, indexFields);
  }
  for (const [name, config] of Record.toEntries(
    table.searchIndexes as Record<string, any>,
  )) {
    definition = definition.searchIndex(name, config);
  }
  for (const [name, config] of Record.toEntries(
    table.vectorIndexes as Record<string, any>,
  )) {
    definition = definition.vectorIndex(name, config);
  }

  tableDefinitionCache.set(table, definition);
  return definition as TableDefinition<
    Table_.TableValidator<Table>,
    Table_.Indexes<Table>,
    Table_.SearchIndexes<Table>,
    Table_.VectorIndexes<Table>
  >;
};

// -----------------------------------------------------------------------------
// System tables
// -----------------------------------------------------------------------------

export const scheduledFunctionsTable = Table_.make(() =>
  Schema.Struct({
    name: Schema.String,
    args: Schema.Array(Schema.Any),
    scheduledTime: Schema.Finite,
    completedTime: Schema.optionalKey(Schema.Finite),
    state: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("pending") }),
      Schema.Struct({ kind: Schema.Literal("inProgress") }),
      Schema.Struct({ kind: Schema.Literal("success") }),
      Schema.Struct({
        kind: Schema.Literal("failed"),
        error: Schema.String,
      }),
      Schema.Struct({ kind: Schema.Literal("canceled") }),
    ]),
  }),
)("_scheduled_functions");

export const storageTable = Table_.make(() =>
  Schema.Struct({
    sha256: Schema.String,
    size: Schema.Finite,
    contentType: Schema.optionalKey(Schema.String),
  }),
)("_storage");

export const systemTables = {
  _scheduled_functions: scheduledFunctionsTable,
  _storage: storageTable,
} as const;

const makeSystemTables = <const Scope_ extends IdScope.IdScope>(
  scope: Scope_,
) => ({
  _scheduled_functions: Table_.make(() => scheduledFunctionsTable.Fields)(
    "_scheduled_functions",
    scope,
  ),
  _storage: Table_.make(() => storageTable.Fields)("_storage", scope),
});

const systemTablesByScope = new Map<
  IdScope.IdScope,
  Record<keyof typeof systemTables, Table_.AnyWithProps>
>();

export const systemTablesForScope = <const Scope_ extends IdScope.IdScope>(
  scope: Scope_,
): ReturnType<typeof makeSystemTables<Scope_>> => {
  const cached = systemTablesByScope.get(scope);
  if (cached !== undefined) {
    // Each cache key is the scope used to construct both tables.
    return cached as ReturnType<typeof makeSystemTables<Scope_>>;
  }
  const tables = makeSystemTables(scope);
  systemTablesByScope.set(scope, tables);
  return tables;
};

export type SystemTables<Scope_ extends IdScope.IdScope = IdScope.App> =
  ReturnType<typeof systemTablesForScope<Scope_>>[keyof typeof systemTables];
