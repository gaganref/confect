import type * as IdScope from "@confect/core/IdScope";
import type {
  ExpressionOrValue,
  FilterBuilder,
  OrderedQuery as ConvexOrderedQuery,
  PaginationOptions,
  PaginationResult,
} from "convex/server";
import { identity, pipe } from "effect/Function";
import type { Option } from "effect";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as DatabaseSchema from "./DatabaseSchema";
import * as Document from "./Document";
import type * as TableInfo from "./TableInfo";
import type * as Table from "./Table";

type NativePaginate<TableInfo_ extends TableInfo.AnyWithProps, Doc> = (
  options: PaginationOptions,
  filter?: (
    q: FilterBuilder<TableInfo.ConvexTableInfo<TableInfo_>>,
  ) => ExpressionOrValue<boolean>,
) => Effect.Effect<PaginationResult<Doc>, Document.DocumentDecodeError>;

export type OrderedQuery<
  TableInfo_ extends TableInfo.AnyWithProps,
  Doc = TableInfo_["document"],
  TargetKind extends DatabaseSchema.Target["kind"] = "app",
> = {
  readonly first: () => Effect.Effect<
    Option.Option<Doc>,
    Document.DocumentDecodeError
  >;
  readonly take: (
    n: number,
  ) => Effect.Effect<ReadonlyArray<Doc>, Document.DocumentDecodeError>;
  readonly collect: () => Effect.Effect<
    ReadonlyArray<Doc>,
    Document.DocumentDecodeError
  >;
  readonly stream: () => Stream.Stream<Doc, Document.DocumentDecodeError>;
  /**
   * Native pagination is application-only. Use `QueryStream.paginate` for
   * component index queries.
   */
  readonly paginate: {
    readonly app: NativePaginate<TableInfo_, Doc>;
    readonly component: {
      readonly "Native pagination is unavailable in components. Use QueryStream.paginate for index queries.": never;
    };
  }[TargetKind];
};

export function make<Table_ extends Table.AnyWithProps>(
  query: ConvexOrderedQuery<
    TableInfo.ConvexTableInfo<TableInfo.TableInfo<Table_>>
  >,
  table: Table_ & { readonly scope: IdScope.App },
): OrderedQuery<TableInfo.TableInfo<Table_>>;
export function make<Table_ extends Table.AnyWithProps>(
  query: ConvexOrderedQuery<
    TableInfo.ConvexTableInfo<TableInfo.TableInfo<Table_>>
  >,
  table: Table_,
): OrderedQuery<
  TableInfo.TableInfo<Table_>,
  TableInfo.TableInfo<Table_>["document"],
  Table.Scope<Table_> extends IdScope.App ? "app" : "component"
>;
export function make<Table_ extends Table.AnyWithProps>(
  query: ConvexOrderedQuery<
    TableInfo.ConvexTableInfo<TableInfo.TableInfo<Table_>>
  >,
  table: Table_,
): OrderedQuery<
  TableInfo.TableInfo<Table_>,
  TableInfo.TableInfo<Table_>["document"],
  DatabaseSchema.Target["kind"]
> {
  type TableInfo_ = TableInfo.TableInfo<Table_>;
  type OrderedQueryFunction<
    FunctionName extends keyof OrderedQuery<TableInfo_>,
  > = OrderedQuery<TableInfo_>[FunctionName];

  const streamEncoded = Stream.fromAsyncIterable(query, identity).pipe(
    Stream.orDie,
  );

  const stream: OrderedQueryFunction<"stream"> = () =>
    pipe(streamEncoded, Stream.mapEffect(Document.decode(table)));

  const first: OrderedQueryFunction<"first"> = () =>
    pipe(stream(), Stream.take(1), Stream.runHead);

  const take: OrderedQueryFunction<"take"> = (n: number) =>
    pipe(stream(), Stream.take(n), Stream.runCollect);

  const collect: OrderedQueryFunction<"collect"> = () =>
    pipe(stream(), Stream.runCollect);

  const paginate: NativePaginate<TableInfo_, TableInfo_["document"]> =
    Effect.fn("OrderedQuery.paginate")(function* (options, filter) {
      const filteredQuery = filter !== undefined ? query.filter(filter) : query;

      const paginationResult = yield* Effect.promise(() =>
        filteredQuery.paginate(options),
      );

      const parsedPage = yield* Effect.forEach(
        paginationResult.page,
        Document.decode(table),
      );

      return {
        page: parsedPage,
        isDone: paginationResult.isDone,
        continueCursor: paginationResult.continueCursor,
        /* v8 ignore start */
        ...(paginationResult.splitCursor
          ? { splitCursor: paginationResult.splitCursor }
          : {}),
        ...(paginationResult.pageStatus
          ? { pageStatus: paginationResult.pageStatus }
          : {}),
        /* v8 ignore stop */
      };
    });

  return {
    first,
    take,
    collect,
    paginate,
    stream,
  };
}
