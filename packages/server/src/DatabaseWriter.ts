import type {
  BetterOmit,
  DocumentByName,
  Expand,
  GenericDatabaseWriter,
  WithoutSystemFields,
} from "convex/server";
import type { GenericId } from "convex/values";
import { pipe } from "effect/Function";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as DatabaseSchema from "./DatabaseSchema.js";
import type * as DataModel from "./DataModel.js";
import type { DocumentByName as DocumentByName_ } from "./DataModel.js";
import * as Document from "./Document.js";
import * as DocumentPatch from "./internal/DocumentPatch.js";
import * as QueryInitializer from "./QueryInitializer.js";
import type * as Table from "./Table.js";

/**
 * The argument accepted by `patch`: like `Partial<Doc>` without system fields,
 * but the fields that are already optional also accept `undefined`, since
 * setting a field to `undefined` unsets it.
 */
export type PatchValue<Doc> = {
  [
    K in keyof Doc as K extends "_id" | "_creationTime" ? never : K
  ]?: undefined extends Doc[K] ? Doc[K] | undefined : Doc[K];
};

export interface DatabaseWriterTableAccessor<
  DataModel_ extends DataModel.AnyWithProps,
  TableName extends DataModel.TableNames<DataModel_>,
  Doc = DocumentByName_<DataModel_, TableName>,
> {
  readonly insert: (
    document: Document.WithoutSystemFields<Doc>,
  ) => Effect.Effect<
    DataModel.Id<DataModel_, TableName>,
    Document.DocumentEncodeError
  >;
  readonly patch: (
    id: DataModel.Id<DataModel_, TableName>,
    patchedValues: PatchValue<Doc>,
  ) => Effect.Effect<
    void,
    | QueryInitializer.GetByIdFailure
    | Document.DocumentDecodeError
    | Document.DocumentEncodeError
  >;
  readonly replace: (
    id: DataModel.Id<DataModel_, TableName>,
    value: Document.WithoutSystemFields<Doc>,
  ) => Effect.Effect<void, Document.DocumentEncodeError>;
  readonly delete: (
    id: DataModel.Id<DataModel_, TableName>,
  ) => Effect.Effect<void>;
}

/**
 * The service shape backing the `DatabaseWriter` tag. Named (rather than an
 * inferred anonymous object) so declaration emit prints
 * `DatabaseWriterService<…>` by reference instead of expanding the data model.
 * `Docs` is the optional named document registry (see
 * `DatabaseReaderService`).
 */
export interface DatabaseWriterService<
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
  Docs = {},
> {
  readonly table: <
    const TableName extends DataModel.TableNames<
      DataModel.FromSchema<DatabaseSchema_>
    >,
  >(
    tableName: TableName,
  ) => DatabaseWriterTableAccessor<
    DataModel.FromSchema<DatabaseSchema_>,
    TableName,
    TableName extends keyof Docs
      ? Docs[TableName]
      : DocumentByName_<DataModel.FromSchema<DatabaseSchema_>, TableName>
  >;
}

/**
 * The tag's _Identifier_ is `Docs`-independent (see `DatabaseReaderTag`); only
 * the _Service_ carries `Docs` so writer inputs print the named doc
 * interfaces.
 */
export type DatabaseWriterTag<
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
  Docs = {},
> = Context.Service<
  DatabaseWriterService<DatabaseSchema_>,
  DatabaseWriterService<DatabaseSchema_, Docs>
>;

/**
 * Decoded documents surrounding one successful write.
 */
export type Change<S extends DatabaseSchema.AnyWithProps> = {
  [Name in DataModel.TableNames<DataModel.FromSchema<S>>]: {
    readonly tableName: Name;
  } & (
    | {
        readonly operation: "insert";
        readonly oldDoc: null;
        readonly newDoc: DocumentByName_<DataModel.FromSchema<S>, Name>;
      }
    | {
        readonly operation: "update";
        readonly oldDoc: DocumentByName_<DataModel.FromSchema<S>, Name>;
        readonly newDoc: DocumentByName_<DataModel.FromSchema<S>, Name>;
      }
    | {
        readonly operation: "delete";
        readonly oldDoc: DocumentByName_<DataModel.FromSchema<S>, Name>;
        readonly newDoc: null;
      }
  );
}[DataModel.TableNames<DataModel.FromSchema<S>>];

/**
 * Runs after the write, in its transaction. A defect aborts the mutation.
 *
 * Only writes through this writer are observed. Raw `ctx.db`, `MutationCtx`
 * writes and a second `DatabaseWriter.make` bypass the hook, so a host that
 * relies on it keeps raw writers out of its functions. Component writers and
 * nested `runMutation` calls each need their own hook installation.
 *
 * Concurrent writes to one document (for example under `Effect.all`) can
 * interleave the read-write-read steps. Await them sequentially when the hook
 * needs exact per-write snapshots. The writer takes no lock, because a hook
 * that writes through the same writer would deadlock under one.
 */
export type Hook<S extends DatabaseSchema.AnyWithProps> = (
  change: Change<S>,
) => Effect.Effect<void>;

export const make = <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexDatabaseWriter: GenericDatabaseWriter<
    DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>
  >,
  hook?: Hook<DatabaseSchema_>,
): DatabaseWriterService<DatabaseSchema_> => {
  type DataModel_ = DataModel.FromSchema<DatabaseSchema_>;

  const table = <const TableName extends DataModel.TableNames<DataModel_>>(
    tableName: TableName,
  ) => {
    const tableDef = DatabaseSchema.tables(databaseSchema)[tableName];

    const insert = Effect.fn("DatabaseWriter.insert")(function* (
      document: Document.WithoutSystemFields<
        DocumentByName_<DataModel_, TableName>
      >,
    ) {
      const encodedDocument = yield* Document.encode(document, tableDef);

      const id = yield* Effect.promise(() =>
        convexDatabaseWriter.insert(
          tableName,
          encodedDocument as WithoutSystemFields<
            DocumentByName<DataModel.ToConvex<DataModel_>, TableName>
          >,
        ),
      );

      // The database supplies the ID in this table's execution scope. Its
      // scope brand is erased at the Convex syscall boundary.
      return id as unknown as DataModel.Id<DataModel_, TableName>;
    });

    // A codec whose encoding spans fields cannot encode a patch on its own, so
    // the patch is merged into the decoded document and the result replaces it.
    const replacePatched = (
      id: DataModel.Id<DataModel_, TableName>,
      patchedValues: PatchValue<
        Document.WithoutSystemFields<DocumentByName_<DataModel_, TableName>>
      >,
    ) =>
      Effect.gen(function* () {
        const originalDecodedDoc = yield* QueryInitializer.getById<
          Table.AnyWithProps,
          TableName
        >(
          convexDatabaseWriter as any,
          tableDef,
        )(id as unknown as GenericId<TableName>);

        const updatedEncodedDoc = yield* pipe(
          patchedValues,
          Record.reduce(originalDecodedDoc, (acc, value, key) =>
            value === undefined
              ? Record.remove(acc, key)
              : Record.set(acc, key, value),
          ),
          Document.encode(tableDef),
        );

        yield* Effect.promise(() =>
          convexDatabaseWriter.replace(
            id as unknown as GenericId<TableName>,
            updatedEncodedDoc as Expand<
              BetterOmit<
                DocumentByName<DataModel.ToConvex<DataModel_>, TableName>,
                "_creationTime" | "_id"
              >
            >,
          ),
        );
      });

    const patch = Effect.fn("DatabaseWriter.patch")(function* (
      id: DataModel.Id<DataModel_, TableName>,
      patchedValues: PatchValue<
        Document.WithoutSystemFields<DocumentByName_<DataModel_, TableName>>
      >,
    ) {
      const encodePatch = DocumentPatch.encoder(tableDef);
      if (encodePatch === undefined) {
        return yield* replacePatched(id, patchedValues);
      }

      const storedDoc = yield* pipe(
        Effect.promise(() =>
          convexDatabaseWriter.get(id as unknown as GenericId<TableName>),
        ),
        Effect.andThen((value) =>
          Effect.fromResult(
            Result.fromNullishOr(
              value,
              () =>
                new QueryInitializer.GetByIdFailure({
                  tableName,
                  id,
                }),
            ),
          ),
        ),
      );
      // The patch must encode and the patched document must decode. When
      // either fails, the stored document decides whose fault that is.
      const encodedPatch = yield* pipe(
        encodePatch(patchedValues),
        Effect.mapError(({ message }) => message),
        Effect.tap((delta) =>
          pipe(
            { ...storedDoc, ...delta },
            Record.filter(Predicate.isNotUndefined),
            Document.decode(tableDef),
            Effect.mapError(({ parseError }) => parseError),
          ),
        ),
        Effect.catch((parseError) =>
          pipe(
            Document.decode(storedDoc, tableDef),
            Effect.andThen(
              Effect.fail(
                new Document.DocumentEncodeError({
                  tableName,
                  id,
                  parseError,
                }),
              ),
            ),
          ),
        ),
      );

      yield* Effect.promise(() =>
        convexDatabaseWriter.patch(
          id as unknown as GenericId<TableName>,
          encodedPatch as Partial<
            DocumentByName<DataModel.ToConvex<DataModel_>, TableName>
          >,
        ),
      );
    });

    const replace = Effect.fn("DatabaseWriter.replace")(function* (
      id: DataModel.Id<DataModel_, TableName>,
      value: Document.WithoutSystemFields<
        DocumentByName_<DataModel_, TableName>
      >,
    ) {
      const updatedEncodedDoc = yield* Document.encode(value, tableDef);

      yield* Effect.promise(() =>
        convexDatabaseWriter.replace(
          id as unknown as GenericId<TableName>,
          updatedEncodedDoc as Expand<
            BetterOmit<
              DocumentByName<DataModel.ToConvex<DataModel_>, TableName>,
              "_creationTime" | "_id"
            >
          >,
        ),
      );
    });

    const delete_ = (id: DataModel.Id<DataModel_, TableName>) =>
      Effect.promise(() =>
        convexDatabaseWriter.delete(id as unknown as GenericId<TableName>),
      );

    const accessor = { insert, patch, replace, delete: delete_ };
    if (hook === undefined) return accessor;

    const read = (id: DataModel.Id<DataModel_, TableName>) =>
      QueryInitializer.getById<Table.AnyWithProps, TableName>(
        convexDatabaseWriter as any,
        tableDef,
      )(id as unknown as GenericId<TableName>);
    const notify = (
      operation: "insert" | "update" | "delete",
      oldDoc: unknown,
      newDoc: unknown,
    ) =>
      hook({ tableName, operation, oldDoc, newDoc } as Change<DatabaseSchema_>);
    const update =
      <A extends ReadonlyArray<unknown>, E, BeforeError>(
        before: (
          id: DataModel.Id<DataModel_, TableName>,
        ) => Effect.Effect<unknown, BeforeError>,
        write: (
          id: DataModel.Id<DataModel_, TableName>,
          ...args: A
        ) => Effect.Effect<void, E>,
      ) =>
      (id: DataModel.Id<DataModel_, TableName>, ...args: A) =>
        Effect.gen(function* () {
          const oldDoc = yield* before(id);
          yield* write(id, ...args);
          yield* notify("update", oldDoc, yield* read(id).pipe(Effect.orDie));
        });

    return {
      insert: (document: Parameters<typeof insert>[0]) =>
        Effect.gen(function* () {
          const id = yield* insert(document);
          yield* notify("insert", null, yield* read(id).pipe(Effect.orDie));
          return id;
        }),
      patch: update(read, patch),
      replace: update((id) => read(id).pipe(Effect.orDie), replace),
      delete: (id: DataModel.Id<DataModel_, TableName>) =>
        Effect.gen(function* () {
          const oldDoc = yield* read(id).pipe(Effect.orDie);
          yield* delete_(id);
          yield* notify("delete", oldDoc, null);
        }),
    };
  };

  return {
    table,
  } as DatabaseWriterService<DatabaseSchema_>;
};

export const DatabaseWriter = <
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
  Docs = {},
>(): DatabaseWriterTag<DatabaseSchema_, Docs> =>
  Context.Service<
    DatabaseWriterService<DatabaseSchema_>,
    DatabaseWriterService<DatabaseSchema_, Docs>
  >("@confect/server/DatabaseWriter");

export type DatabaseWriter<
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
> = DatabaseWriterService<DatabaseSchema_>;

export const layer = <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexDatabaseWriter: GenericDatabaseWriter<
    DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>
  >,
  hook?: Hook<DatabaseSchema_>,
) =>
  Layer.succeed(
    DatabaseWriter<DatabaseSchema_>(),
    make(databaseSchema, convexDatabaseWriter, hook),
  );
