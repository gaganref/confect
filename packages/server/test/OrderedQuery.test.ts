import { IdScope, Table } from "@confect/core";
import {
  DatabaseSchema,
  QueryStream,
  OrderedQuery,
  QueryInitializer,
} from "@confect/server";
import type { Document, TableInfo, DatabaseReader } from "@confect/server";
import { describe, expectTypeOf, it } from "@effect/vitest";
import type {
  PaginationOptions,
  PaginationResult,
  OrderedQuery as ConvexOrderedQuery,
} from "convex/server";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const fields = () => Schema.Struct({ title: Schema.String });
const scope = IdScope.component("@example/notes");
const appNotes = Table.make(fields)
  .index("by_title", ["title"])
  .searchIndex("search_title", { searchField: "title" })("notes");
const componentNotes = Table.make(fields)
  .index("by_title", ["title"])
  .searchIndex("search_title", { searchField: "title" })("notes", scope);
const appSchema = DatabaseSchema.make({ notes: appNotes });
const componentSchema = DatabaseSchema.make(
  { notes: componentNotes },
  { kind: "component", scope },
);
const options = { cursor: null, numItems: 2 } satisfies PaginationOptions;

interface NamedDoc {
  readonly title: string;
}

describe("OrderedQuery", () => {
  it("preserves application pagination, filters, detached calls, and named documents", () => {
    const check = (
      reader: DatabaseReader.DatabaseReaderService<
        typeof appSchema,
        { notes: NamedDoc }
      >,
    ) => {
      const query = reader.table("notes").index("by_title");
      expectTypeOf(
        query.paginate(options, (q) => q.eq(q.field("title"), "Ada")),
      ).toEqualTypeOf<
        Effect.Effect<PaginationResult<NamedDoc>, Document.DocumentDecodeError>
      >();
      const paginate = query.paginate;
      expectTypeOf(paginate(options)).toEqualTypeOf<
        Effect.Effect<PaginationResult<NamedDoc>, Document.DocumentDecodeError>
      >();
      const ranged = reader
        .table("notes")
        .index("by_title", (q) => q.eq("title", "Ada"), "desc")
        .paginate(options);
      const search = reader
        .table("notes")
        .search("search_title", (q) => q.search("title", "Ada"))
        .paginate(options);
      const scheduled = reader
        .table("_scheduled_functions")
        .index("by_creation_time")
        .paginate(options);
      const storage = reader
        .table("_storage")
        .index("by_creation_time")
        .paginate(options);
      return { ranged, search, scheduled, storage };
    };
    expectTypeOf(check).toBeFunction();
  });

  it("preserves pagination in generic application helpers", () => {
    const erased = (query: OrderedQuery.OrderedQuery<TableInfo.AnyWithProps>) =>
      query.paginate(options);
    const generic = <Info extends TableInfo.AnyWithProps>(
      query: OrderedQuery.OrderedQuery<Info>,
    ) => query.paginate(options);
    const application = <Info extends TableInfo.TableInfo<typeof appNotes>>(
      query: OrderedQuery.OrderedQuery<Info>,
    ) => query.paginate(options);
    const reader = <
      Schema_ extends DatabaseSchema.DatabaseSchema<
        Readonly<Record<string, Table.AnyWithProps>>
      >,
    >(
      database: DatabaseReader.DatabaseReaderService<Schema_>,
      name: DatabaseSchema.TableNames<Schema_>,
    ) => database.table(name).index("by_creation_time").paginate(options);
    expectTypeOf(erased).toBeFunction();
    expectTypeOf(generic).toBeFunction();
    expectTypeOf(application).toBeFunction();
    expectTypeOf(reader).toBeFunction();
  });

  it("preserves native pagination from generic application query constructors", () => {
    const ordered = <T extends typeof appNotes>(
      ...args: Parameters<typeof OrderedQuery.make<T>>
    ) => OrderedQuery.make(...args).paginate(options);
    const initializer = <T extends typeof appNotes>(
      ...args: Parameters<typeof QueryInitializer.make<T, Table.Name<T>>>
    ) =>
      QueryInitializer.make<T, Table.Name<T>>(...args)
        .index("by_creation_time")
        .paginate(options);
    expectTypeOf(ordered).toBeFunction();
    expectTypeOf(initializer).toBeFunction();
  });

  it("keeps collect available from component and scope-agnostic constructors", () => {
    const ordered = <T extends Table.AnyWithProps>(
      ...args: Parameters<typeof OrderedQuery.make<T>>
    ) => OrderedQuery.make<T>(...args).collect();
    const componentOrdered = <T extends typeof componentNotes>(
      ...args: Parameters<typeof OrderedQuery.make<T>>
    ) => OrderedQuery.make<T>(...args).collect();
    const initializer = <T extends Table.AnyWithProps>(
      ...args: Parameters<typeof QueryInitializer.make<T, Table.Name<T>>>
    ) =>
      QueryInitializer.make<T, Table.Name<T>>(...args)
        .index("by_creation_time")
        .collect();
    const componentInitializer = <T extends typeof componentNotes>(
      ...args: Parameters<typeof QueryInitializer.make<T, Table.Name<T>>>
    ) =>
      QueryInitializer.make<T, Table.Name<T>>(...args)
        .index("by_creation_time")
        .collect();
    expectTypeOf(ordered).toBeFunction();
    expectTypeOf(componentOrdered).toBeFunction();
    expectTypeOf(initializer).toBeFunction();
    expectTypeOf(componentInitializer).toBeFunction();
  });

  it("rejects native component pagination and directs index queries to QueryStream.paginate", () => {
    const check = (
      reader: DatabaseReader.DatabaseReaderService<
        typeof componentSchema,
        { notes: NamedDoc }
      >,
    ) => {
      const query = reader.table("notes").index("by_title");
      // @ts-expect-error Native pagination is unavailable in components. Use QueryStream.paginate.
      query.paginate(options);
      const ranged = reader
        .table("notes")
        .index("by_title", (q) => q.eq("title", "Ada"));
      // @ts-expect-error The index-range overload retains the component scope.
      ranged.paginate(options);
      const search = reader
        .table("notes")
        .search("search_title", (q) => q.search("title", "Ada"));
      // @ts-expect-error Search results also use native pagination.
      search.paginate(options);
      const scheduled = reader
        .table("_scheduled_functions")
        .index("by_creation_time");
      // @ts-expect-error Component system tables have the same pagination restriction.
      scheduled.paginate(options);
      // @ts-expect-error Component storage metadata also belongs to the component database.
      reader.table("_storage").index("by_creation_time").paginate(options);
      const paginate = query.paginate;
      // @ts-expect-error Detaching the property cannot make it callable.
      paginate(options);
      // @ts-expect-error A component paginator cannot be passed as an application callback.
      const callback: (options: PaginationOptions) => unknown = paginate;
      void callback;
      // @ts-expect-error A component query cannot be widened to an application helper's query type.
      const applicationQuery: OrderedQuery.OrderedQuery<TableInfo.AnyWithProps> =
        query;
      void applicationQuery;
      expectTypeOf(query.paginate).toEqualTypeOf<{
        readonly "Native pagination is unavailable in components. Use QueryStream.paginate for index queries.": never;
      }>();
      expectTypeOf(query.collect()).toEqualTypeOf<
        Effect.Effect<ReadonlyArray<NamedDoc>, Document.DocumentDecodeError>
      >();
      return QueryStream.paginate(
        reader.table("notes").stream("by_title"),
        options,
      );
    };
    expectTypeOf(check).toBeFunction();
  });

  it("rejects pagination when a table may belong to a component", () => {
    const check = (
      reader: DatabaseReader.DatabaseReaderService<
        typeof appSchema | typeof componentSchema
      >,
    ) => {
      // @ts-expect-error A reader that may address a component must not expose native pagination.
      reader.table("notes").index("by_title").paginate(options);
    };
    const checkScope = (mixedScope: IdScope.App | typeof scope) => {
      const notes = Table.make(fields)("notes", mixedScope);
      const checkQuery = (
        query: ConvexOrderedQuery<
          TableInfo.ConvexTableInfo<TableInfo.TableInfo<typeof notes>>
        >,
      ) => {
        const ordered = OrderedQuery.make(query, notes);
        // @ts-expect-error A single table with an app/component scope union is gated too.
        ordered.paginate(options);
      };
      return checkQuery;
    };
    expectTypeOf(check).toBeFunction();
    expectTypeOf(checkScope).toBeFunction();
  });
});
