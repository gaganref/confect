import type * as QueryStreamKeyLabels from "@confect/server/QueryStreamKeyLabels";
import * as QueryStreamReadBudget from "@confect/server/QueryStreamReadBudget";
import { identity } from "effect/Function";
import * as Result from "effect/Result";
import * as QueryStreamKeyLayout from "@confect/server/QueryStreamKeyLayout";
import type * as QueryStreamOrderDirection from "@confect/server/QueryStreamOrderDirection";
import type * as QueryStreamKeyValues from "@confect/server/QueryStreamKeyValues";
import * as QueryStreamKey from "@confect/server/QueryStreamKey";
import * as QueryStreamKeyBounds from "@confect/server/QueryStreamKeyBounds";
import * as QueryStreamCursor from "@confect/server/QueryStreamCursor";
import * as QueryStream from "@confect/server/QueryStream";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const encodeCursor =
  (layout: QueryStreamKeyLayout.QueryStreamKeyLayout) =>
  (values: QueryStreamKeyValues.QueryStreamKeyValues) =>
    Effect.flatMap(
      Effect.fromResult(QueryStreamKey.complete(layout, values)),
      Schema.encodeEffect(QueryStreamCursor.fromKeyLayout(layout)),
    );

describe("QueryStream type parameters", () => {
  it("accepts direction third and defaults errors and requirements to never", () => {
    const source = new QueryStream.QueryStream<
      number,
      QueryStreamKeyLabels.QueryStreamKeyLabels<["_id"]>,
      "desc"
    >(
      "desc",
      Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex(["_id"]), identity),
      Stream.empty,
    );

    expect(source.orderDirection).toBe("desc");
    expectTypeOf(source.toStream()).toEqualTypeOf<Stream.Stream<number>>();
    expectTypeOf(source.annotated).toEqualTypeOf<
      Stream.Stream<
        QueryStream.Element<number>,
        never,
        QueryStreamReadBudget.QueryStreamReadBudget
      >
    >();
    expectTypeOf<
      QueryStream.QueryStream<
        number,
        QueryStreamKeyLabels.QueryStreamKeyLabels<["_id"]>
      >
    >().toEqualTypeOf<
      QueryStream.QueryStream<
        number,
        QueryStreamKeyLabels.QueryStreamKeyLabels<["_id"]>,
        QueryStreamOrderDirection.QueryStreamOrderDirection
      >
    >();
    expectTypeOf<
      QueryStream.QueryStream<
        number,
        QueryStreamKeyLabels.QueryStreamKeyLabels<["_id"]>,
        "desc",
        Error
      >
    >().toEqualTypeOf<
      QueryStream.QueryStream<
        number,
        QueryStreamKeyLabels.QueryStreamKeyLabels<["_id"]>,
        "desc",
        Error,
        never
      >
    >();
  });

  it("carries the fourth and fifth parameters into the Effect stream channels", () => {
    type Source = QueryStream.QueryStream<
      number,
      QueryStreamKeyLabels.QueryStreamKeyLabels<["_id"]>,
      "asc",
      Error,
      { readonly service: "query" }
    >;

    expectTypeOf<Source["orderDirection"]>().toEqualTypeOf<"asc">();
    expectTypeOf<ReturnType<Source["toStream"]>>().toEqualTypeOf<
      Stream.Stream<number, Error, { readonly service: "query" }>
    >();
  });
});

describe("QueryStream.merge", () => {
  it.effect.each(["asc", "desc"] as const)(
    "drains buffered chunks stably in %s order",
    (direction) =>
      Effect.gen(function* () {
        const source = (label: string, ranks: ReadonlyArray<number>) =>
          new QueryStream.QueryStream<
            string,
            QueryStreamKeyLabels.QueryStreamKeyLabels<[]>,
            typeof direction
          >(
            direction,
            Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
            Stream.fromIterable(
              ranks.map(
                (rank) =>
                  new QueryStream.Element({
                    doc: Option.some(`${label}:${rank}`),
                    keyValues: [rank],
                  }),
              ),
            ),
          );
        const ascending = direction === "asc";
        const result = yield* Stream.runCollect(
          QueryStream.merge([
            source("left", ascending ? [1, 2, 2, 5] : [5, 2, 2, 1]),
            source("right", ascending ? [0, 2, 3, 4, 6] : [6, 4, 3, 2, 0]),
            QueryStream.empty<string>()(
              Result.getOrThrowWith(
                QueryStreamKeyLayout.fromIndex([]),
                identity,
              ),
              direction,
            ),
          ]),
        );
        expect(result).toEqual(
          ascending
            ? [
                "right:0",
                "left:1",
                "left:2",
                "left:2",
                "right:2",
                "right:3",
                "right:4",
                "left:5",
                "right:6",
              ]
            : [
                "right:6",
                "left:5",
                "right:4",
                "right:3",
                "left:2",
                "left:2",
                "right:2",
                "left:1",
                "right:0",
              ],
        );
      }),
  );
});

describe("QueryStream key layouts", () => {
  const explicitFirst = QueryStreamKeyLayout.concat(
    Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex(["_id"]), identity),
    Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
  );
  const implicitFirst = QueryStreamKeyLayout.concat(
    Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
    Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex(["_id"]), identity),
  );

  it("rejects merging equal names with different implicit positions in either order", () => {
    const left = QueryStream.empty<string>()(explicitFirst);
    const right = QueryStream.empty<string>()(implicitFirst);
    expect(QueryStreamKeyLayout.visibleLabels(left.keyLayout)).toEqual(
      QueryStreamKeyLayout.visibleLabels(right.keyLayout),
    );
    for (const streams of [
      [left, right],
      [right, left],
    ] as const) {
      expect(() => QueryStream.merge(streams)).toThrow(
        QueryStream.IncompatibleStreamsError,
      );
    }
  });

  it.effect(
    "validates later inner streams even when their logical labels and runtime names agree",
    () =>
      Effect.gen(function* () {
        const outer = new QueryStream.QueryStream(
          "asc",
          Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
          Stream.make(
            new QueryStream.Element({ doc: Option.some(1), keyValues: [1] }),
            new QueryStream.Element({ doc: Option.some(2), keyValues: [2] }),
          ),
        );
        const joined = QueryStream.flatMap(
          outer,
          (row) =>
            QueryStream.empty<string>()(
              row === 1 ? explicitFirst : implicitFirst,
            ),
          { innerKeyLayout: explicitFirst },
        );
        const defect = yield* Stream.runCollect(joined).pipe(
          Effect.catchDefect(Effect.succeed),
        );
        expect(defect).toBeInstanceOf(
          QueryStream.InnerStreamLayoutMismatchError,
        );
        expect(defect).toMatchObject({
          _tag: "InnerStreamLayoutMismatchError",
          expectedKeyLayout: explicitFirst,
          actualKeyLayout: implicitFirst,
        });
      }),
  );

  it.effect("validates a new inner layout on subsequent runs", () =>
    Effect.gen(function* () {
      const outer = new QueryStream.QueryStream(
        "asc",
        Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
        Stream.make(
          new QueryStream.Element({ doc: Option.some(1), keyValues: [1] }),
        ),
      );
      let layout = explicitFirst;
      const joined = QueryStream.flatMap(
        outer,
        () => QueryStream.empty<string>()(layout),
        { innerKeyLayout: explicitFirst },
      );
      expect(yield* Stream.runCollect(joined)).toEqual([]);
      layout = implicitFirst;
      const defect = yield* Stream.runCollect(joined).pipe(
        Effect.catchDefect(Effect.succeed),
      );
      expect(defect).toMatchObject({
        _tag: "InnerStreamLayoutMismatchError",
        expectedKeyLayout: explicitFirst,
        actualKeyLayout: implicitFirst,
      });
    }),
  );

  it.effect(
    "validates later inner directions when the type permits either direction",
    () =>
      Effect.gen(function* () {
        const outer = new QueryStream.QueryStream<
          string,
          QueryStreamKeyLabels.QueryStreamKeyLabels<[]>,
          QueryStreamOrderDirection.QueryStreamOrderDirection
        >(
          "asc",
          Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
          Stream.make(
            new QueryStream.Element({
              doc: Option.some("asc"),
              keyValues: [1],
            }),
            new QueryStream.Element({
              doc: Option.some("desc"),
              keyValues: [2],
            }),
          ),
        );
        const layout = Result.getOrThrowWith(
          QueryStreamKeyLayout.fromIndex(["_id"]),
          identity,
        );
        const joined = QueryStream.flatMap(
          outer,
          (row) =>
            QueryStream.empty<string>()(layout, row === "asc" ? "asc" : "desc"),
          { innerKeyLayout: layout },
        );
        const defect = yield* Stream.runCollect(joined).pipe(
          Effect.catchDefect(Effect.succeed),
        );
        expect(defect).toMatchObject({
          _tag: "InnerStreamOrderMismatchError",
          expectedOrderDirection: "asc",
          actualOrderDirection: "desc",
        });
      }),
  );

  it("requires the constructor layout to witness its declared visible labels", () => {
    const invalid = new QueryStream.QueryStream<
      string,
      QueryStreamKeyLabels.QueryStreamKeyLabels<["_id"]>,
      "asc"
    >(
      "asc",
      // @ts-expect-error An implicit ID is absent from the visible labels.
      Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
      Stream.empty,
    );
    void invalid;
  });
});

describe("QueryStream.Element", () => {
  it("constructs an element with an inferred document type and readonly fields", () => {
    const doc = Option.some({ text: "hello" });
    const keyValues: QueryStreamKeyValues.QueryStreamKeyValues = [
      "hello",
      1,
      "id",
    ];
    const element = new QueryStream.Element({ doc, keyValues });

    expectTypeOf(element).toEqualTypeOf<
      QueryStream.Element<{ text: string }>
    >();
    expectTypeOf(element).toExtend<{
      readonly doc: Option.Option<{ text: string }>;
      readonly keyValues: QueryStreamKeyValues.QueryStreamKeyValues;
    }>();
    expect(element.doc).toBe(doc);
    expect(element.keyValues).toBe(keyValues);
    expect(element.pipe((value) => Option.isSome(value.doc))).toBe(true);
  });

  it("constructs a filtered-out element without losing its key values", () => {
    const keyValues: QueryStreamKeyValues.QueryStreamKeyValues = [
      undefined,
      "id",
    ];
    const element = new QueryStream.Element({ doc: Option.none(), keyValues });

    expectTypeOf(element).toEqualTypeOf<QueryStream.Element<never>>();
    expect(element.doc).toEqual(Option.none());
    expect(element.keyValues).toBe(keyValues);
  });
});

describe.each(["asc", "desc"] as const)(
  "QueryStream.paginate (%s)",
  (order) => {
    it.effect.each([
      { start: false, end: false },
      { start: true, end: false },
      { start: false, end: true },
      { start: true, end: true },
    ])(
      "preserves optional bounds with start=$start and end=$end",
      ({ start, end }) =>
        Effect.gen(function* () {
          const values = order === "asc" ? [1, 2, 3, 4, 5] : [5, 4, 3, 2, 1];
          const source = new QueryStream.QueryStream(
            order,
            Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
            Stream.fromIterable(
              values.map(
                (value) =>
                  new QueryStream.Element({
                    doc: Option.some(value),
                    keyValues: [value],
                  }),
              ),
            ),
          );
          const result = yield* QueryStream.paginate(source, {
            cursor: start
              ? yield* encodeCursor(source.keyLayout)([values[1]])
              : null,
            ...(end
              ? {
                  endCursor: yield* encodeCursor(source.keyLayout)([values[3]]),
                }
              : {}),
            numItems: 10,
          });

          expect(result.page).toEqual(values.slice(start ? 2 : 0, end ? 4 : 5));
          expect(result.isDone).toBe(!end);
          expect(result.continueCursor).toBe(
            end
              ? yield* encodeCursor(source.keyLayout)([values[3]])
              : QueryStreamCursor.END_CURSOR,
          );
        }),
    );

    it.effect.each(["cursor", "endCursor"] as const)(
      "rejects an incompatible %s before reading documents",
      (bound) =>
        Effect.gen(function* () {
          let reads = 0;
          const source = new QueryStream.QueryStream(
            order,
            Result.getOrThrowWith(
              QueryStreamKeyLayout.fromIndex(["text", "_creationTime"]),
              identity,
            ),
            Stream.fromEffect(
              Effect.sync(() => {
                reads++;
                return new QueryStream.Element({
                  doc: Option.some("apple"),
                  keyValues: ["apple", 1, "id"],
                });
              }),
            ),
          );

          for (const cursor of [
            '["apple",1,"id"]',
            yield* encodeCursor(
              Result.getOrThrowWith(
                QueryStreamKeyLayout.fromIndex([
                  "body",
                  "_creationTime",
                  "_id",
                ]),
                identity,
              ),
            )(["apple", 1, "id"]),
            yield* encodeCursor(
              Result.getOrThrowWith(
                QueryStreamKeyLayout.fromIndex([
                  "_creationTime",
                  "text",
                  "_id",
                ]),
                identity,
              ),
            )(["apple", 1, "id"]),
          ]) {
            for (const numItems of [0, 1]) {
              const result = yield* QueryStream.paginate(source, {
                cursor: yield* encodeCursor(source.keyLayout)([
                  "apple",
                  0,
                  "before",
                ]),
                numItems,
                [bound]: cursor,
              }).pipe(Effect.catchDefect(Effect.succeed));

              expect(result).toBeInstanceOf(ConvexError);
              expect(result).toMatchObject({
                data: { paginationError: "InvalidCursor" },
              });
            }
          }
          expect(reads).toBe(0);
        }),
    );

    it.effect("paginates tied values using the implicit ID", () =>
      Effect.gen(function* () {
        const ids = order === "asc" ? ["a", "b"] : ["b", "a"];
        const source = new QueryStream.QueryStream(
          order,
          Result.getOrThrowWith(
            QueryStreamKeyLayout.fromIndex(["text", "_creationTime"]),
            identity,
          ),
          Stream.fromIterable(
            ids.map(
              (id) =>
                new QueryStream.Element({
                  doc: Option.some(id),
                  keyValues: ["apple", 1, id],
                }),
            ),
          ),
        );
        const first = yield* QueryStream.paginate(source, {
          cursor: null,
          numItems: 1,
        });
        const second = yield* QueryStream.paginate(source, {
          cursor: first.continueCursor,
          numItems: 1,
        });
        const end = yield* QueryStream.paginate(source, {
          cursor: second.continueCursor,
          numItems: 1,
        });

        expect([...first.page, ...second.page]).toEqual(ids);
        expect(
          QueryStreamKey.values(
            yield* Schema.decodeEffect(
              QueryStreamCursor.fromKeyLayout(source.keyLayout),
            )(first.continueCursor),
          ),
        ).toEqual(["apple", 1, ids[0]]);
        expect(end).toMatchObject({
          page: [],
          isDone: true,
          continueCursor: QueryStreamCursor.END_CURSOR,
        });
      }),
    );

    it.effect("pins a page to the end sentinel", () =>
      Effect.gen(function* () {
        const source = new QueryStream.QueryStream(
          order,
          Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
          Stream.make(
            new QueryStream.Element({ doc: Option.some(1), keyValues: [1] }),
          ),
        );
        const result = yield* QueryStream.paginate(source, {
          cursor: null,
          endCursor: QueryStreamCursor.END_CURSOR,
          numItems: 1,
        });
        expect(result).toEqual({
          page: [1],
          isDone: true,
          continueCursor: QueryStreamCursor.END_CURSOR,
        });
      }),
    );
  },
);

describe("QueryStream", () => {
  const elements = [
    new QueryStream.Element({ doc: Option.some(1), keyValues: [1] }),
    new QueryStream.Element({ doc: Option.none<number>(), keyValues: [2] }),
    new QueryStream.Element({ doc: Option.some(3), keyValues: [3] }),
  ];
  const source = new QueryStream.QueryStream(
    "asc",
    Result.getOrThrowWith(QueryStreamKeyLayout.fromIndex([]), identity),
    Stream.fromIterable(elements),
  );

  it.effect("consumes constructed elements as present documents only", () =>
    Effect.gen(function* () {
      expect(yield* Stream.runCollect(source)).toEqual([1, 3]);
    }),
  );

  it.effect(
    "constructs mapped and filtered elements with their original keys",
    () =>
      Effect.gen(function* () {
        const transformed = source.pipe(
          QueryStream.filter((doc) => doc > 1),
          QueryStream.map((doc) => doc.toString()),
        );
        const result = yield* Stream.runCollect(transformed.annotated).pipe(
          Effect.provideServiceEffect(
            QueryStreamReadBudget.QueryStreamReadBudget,
            QueryStreamReadBudget.make({
              maximumRowsRead: Option.none(),
              maximumBytesRead: Option.none(),
            }),
          ),
        );

        expect(result).toEqual([
          new QueryStream.Element({ doc: Option.none(), keyValues: [1] }),
          new QueryStream.Element({ doc: Option.none(), keyValues: [2] }),
          new QueryStream.Element({ doc: Option.some("3"), keyValues: [3] }),
        ]);
        for (const element of result) {
          expect(element).toBeInstanceOf(QueryStream.Element);
        }
      }),
  );

  it.effect(
    "preserves filtered elements through effectful transformations",
    () =>
      Effect.gen(function* () {
        const visited: Array<number> = [];
        const transformed = source.pipe(
          QueryStream.mapEffect((doc) =>
            Effect.sync(() => {
              visited.push(doc);
              return doc.toString();
            }),
          ),
        );
        const result = yield* Stream.runCollect(transformed.annotated).pipe(
          Effect.provideServiceEffect(
            QueryStreamReadBudget.QueryStreamReadBudget,
            QueryStreamReadBudget.make({
              maximumRowsRead: Option.none(),
              maximumBytesRead: Option.none(),
            }),
          ),
        );

        expect(visited).toEqual([1, 3]);
        expect(result).toEqual([
          new QueryStream.Element({ doc: Option.some("1"), keyValues: [1] }),
          new QueryStream.Element({ doc: Option.none(), keyValues: [2] }),
          new QueryStream.Element({ doc: Option.some("3"), keyValues: [3] }),
        ]);
        for (const element of result) {
          expect(element).toBeInstanceOf(QueryStream.Element);
        }
      }),
  );
});

describe("QueryStream.narrow", () => {
  it("checks layout compatibility before invoking a narrowing recipe", () => {
    const layout = Result.getOrThrow(QueryStreamKeyLayout.fromIndex(["score"]));
    const other = Result.getOrThrow(QueryStreamKeyLayout.fromIndex(["rank"]));
    const received: Array<QueryStreamKeyBounds.ParsedBounds> = [];
    const source = new QueryStream.QueryStream<
      number,
      QueryStreamKeyLabels.QueryStreamKeyLabels<["score"]>,
      "asc"
    >("asc", layout, Stream.empty, undefined, (bounds) => {
      received.push(bounds);
      return QueryStream.empty<number>()(layout);
    });
    const narrow = Option.getOrThrow(Option.fromUndefinedOr(source.narrowWith));
    for (const bounds of [
      QueryStreamKeyBounds.unbounded(other),
      Result.getOrThrow(
        QueryStreamKeyBounds.parse(other, {
          lower: Option.some({ keyValues: [3], inclusive: true }),
          upper: Option.none(),
        }),
      ),
    ]) {
      expect(() => narrow(bounds)).toThrow(
        QueryStreamKeyLayout.KeyLayoutMismatchError,
      );
    }
    expect(received).toEqual([]);
    const equivalent = Result.getOrThrow(
      QueryStreamKeyLayout.fromIndex(["score"]),
    );
    const accepted = QueryStreamKeyBounds.unbounded(equivalent);
    const result = narrow(accepted);
    expect(result.keyLayout).toBe(layout);
    expect(received).toEqual([accepted]);
    expect(received[0]).toBe(accepted);
  });

  it.each(["asc", "desc"] as const)(
    "preserves parsed bounds through transforms and merge in %s order",
    (order) => {
      const layout = Result.getOrThrow(
        QueryStreamKeyLayout.fromIndex(["score"]),
      );
      const received: Array<QueryStreamKeyBounds.ParsedBounds> = [];
      const source = () =>
        new QueryStream.QueryStream<
          number,
          QueryStreamKeyLabels.QueryStreamKeyLabels<["score"]>,
          typeof order
        >(order, layout, Stream.empty, undefined, (bounds) => {
          received.push(bounds);
          return QueryStream.empty<number>()(layout, order);
        });
      const transformed = source().pipe(
        QueryStream.map((value) => value + 1),
        QueryStream.filter((value) => value > 0),
        QueryStream.mapEffect(Effect.succeed),
        QueryStream.filterEffect(() => Effect.succeed(true)),
      );
      const merged = QueryStream.merge([transformed, source()]);
      const lower = { keyValues: [3], inclusive: false };
      const upper = { keyValues: [5, "id"], inclusive: true };
      const start = order === "asc" ? lower : upper;
      const end = order === "asc" ? upper : lower;
      const narrowed = QueryStream.narrow(merged, { start, end });

      expect(narrowed.keyLayout).toBe(layout);
      expect(narrowed.orderDirection).toBe(order);
      expect(received).toHaveLength(2);
      const [first, second] = received;
      expect(first).toBe(second);
      for (const bounds of received) {
        for (const [endpoint, raw] of [
          [bounds.lower, order === "asc" ? start : end],
          [bounds.upper, order === "asc" ? end : start],
        ] as const) {
          const bound = Option.getOrThrow(endpoint);
          expect(bound.key._tag).toBe("Prefix");
          expect(QueryStreamKey.layout(bound.key)).toBe(layout);
          expect(QueryStreamKey.values(bound.key)).toBe(raw.keyValues);
          expect(bound.inclusive).toBe(raw.inclusive);
        }
      }
      expectTypeOf<QueryStreamKeyBounds.KeyBounds>().not.toExtend<
        Parameters<NonNullable<typeof merged.narrowWith>>[0]
      >();
    },
  );

  it("rebinds renamed bounds to the underlying stream's layout", () => {
    const layout = Result.getOrThrow(QueryStreamKeyLayout.fromIndex(["score"]));
    const received: Array<QueryStreamKeyBounds.ParsedBounds> = [];
    const source = new QueryStream.QueryStream<
      number,
      QueryStreamKeyLabels.QueryStreamKeyLabels<["score"]>,
      "asc"
    >("asc", layout, Stream.empty, undefined, (bounds) => {
      received.push(bounds);
      return QueryStream.empty<number>()(layout);
    });
    const values = [3];
    const renamed = QueryStream.renameKey(source, ["rank"]);
    const narrowed = QueryStream.narrow(renamed, {
      start: { keyValues: values, inclusive: true },
    });
    expect(
      QueryStreamKeyLayout.Equivalence(narrowed.keyLayout, renamed.keyLayout),
    ).toBe(true);
    expect(received).toHaveLength(1);
    for (const bounds of received) {
      const bound = Option.getOrThrow(bounds.lower);
      expect(QueryStreamKey.layout(bound.key)).toBe(layout);
      expect(QueryStreamKey.values(bound.key)).toBe(values);
    }
  });
});

describe("QueryStream boundary errors", () => {
  it("rejects oversized bounds before constructing a scan", () => {
    const layout = Result.getOrThrow(QueryStreamKeyLayout.fromIndex(["score"]));
    const source = QueryStream.empty<never>()(layout);
    expect(() =>
      QueryStream.narrow(source, {
        start: { keyValues: [3, "id", 4], inclusive: true },
      }),
    ).toThrow(QueryStreamKey.KeyWidthMismatchError);
  });

  const layout = Result.getOrThrowWith(
    QueryStreamKeyLayout.fromIndex([]),
    identity,
  );

  it("preserves the layout errors when stream arguments are invalid", () => {
    const fieldPaths: ReadonlyArray<string> = ["text"];
    const source = QueryStream.empty<string>()(
      Result.getOrThrowWith(
        QueryStreamKeyLayout.fromIndex(fieldPaths),
        identity,
      ),
    );
    const prefix: ReadonlyArray<string> = ["missing"];
    const replacement: ReadonlyArray<string> = [];
    expect(() => QueryStream.distinct(source, prefix)).toThrow(
      QueryStreamKeyLayout.InvalidLabelPrefixError,
    );
    expect(() => QueryStream.renameKey(source, replacement)).toThrow(
      QueryStreamKeyLayout.LabelCountMismatchError,
    );
  });

  it("throws a named error when a reversal recipe is absent", () => {
    const source = new QueryStream.QueryStream("asc", layout, Stream.empty);
    expect(() => QueryStream.reverse(source)).toThrow(
      QueryStream.MissingReversalRecipeError,
    );
  });

  it.effect("preserves the named defect for a zero-sized initial page", () =>
    Effect.gen(function* () {
      const source = QueryStream.empty<string>()(layout);
      const defect = yield* QueryStream.paginate(source, {
        numItems: 0,
        cursor: null,
      }).pipe(Effect.catchDefect(Effect.succeed));
      expect(defect).toBeInstanceOf(QueryStream.EmptyInitialPageError);
    }),
  );
});

describe("QueryStream.ReadBudgetExceededError", () => {
  it.each(["rowsRead", "bytesRead"] as const)(
    "rejects invalid %s counts",
    (field) => {
      for (const value of [
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        expect(
          Option.isNone(
            QueryStream.ReadBudgetExceededError.makeOption({
              rowsRead: 0,
              bytesRead: 0,
              [field]: value,
            }),
          ),
        ).toBe(true);
      }
    },
  );

  it("accepts zero row and byte counts", () => {
    expect(
      new QueryStream.ReadBudgetExceededError({
        rowsRead: 0,
        bytesRead: 0,
      }),
    ).toMatchObject({ rowsRead: 0, bytesRead: 0 });
  });

  it("preserves the budget error tag and details", () => {
    const error = new QueryStream.ReadBudgetExceededError({
      rowsRead: 2,
      bytesRead: 20,
    });
    expect(error._tag).toBe("ReadBudgetExceededError");
    expect(error.rowsRead).toBe(2);
    expect(error.bytesRead).toBe(20);
    expect(error.message).toBe(
      "The read budget was exhausted before the query stream completed; increase the budget or simplify the query",
    );
    expect(error.message).not.toContain("QueryStream.paginate");
  });
});

describe("QueryStream.defer", () => {
  const layout = Result.getOrThrow(QueryStreamKeyLayout.fromIndex([]));
  const options = { keyLayout: layout, orderDirection: "asc" } as const;

  it.effect(
    "defers unused template checks when constructing a flatMap join",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const rows = (values: ReadonlyArray<number>) =>
          new QueryStream.QueryStream(
            "asc",
            layout,
            Stream.fromIterable(values).pipe(
              Stream.map((value) => {
                reads++;
                return new QueryStream.Element({
                  doc: Option.some(value),
                  keyValues: [value],
                });
              }),
            ),
          );
        // Each loaded placement establishes its inner range; the full-range template needs an access check.
        const all = Effect.sync(() => {
          reads += 2;
          return rows([1, 2]);
        });
        const eagerTemplate = yield* all;
        const join = (template: typeof eagerTemplate) =>
          rows([1, 2]).pipe(
            QueryStream.flatMap(
              (placement) =>
                QueryStream.defer(options, Effect.succeed(rows([placement]))),
              { innerKeyLayout: template.keyLayout },
            ),
            QueryStream.paginate({ cursor: null, numItems: 10 }),
          );
        expect((yield* join(eagerTemplate)).page).toEqual([1, 2]);
        expect(reads).toBe(6);
        reads = 0;
        const template = QueryStream.defer(options, all);
        const page = join(template);
        expect(reads).toBe(0);
        expect((yield* page).page).toEqual([1, 2]);
        expect(reads).toBe(4);
      }),
  );

  it.effect(
    "defers checks through narrowing and reversal and reruns on consumption",
    () =>
      Effect.gen(function* () {
        let checks = 0;
        let boundsSeen = 0;
        const inner = new QueryStream.QueryStream(
          "asc",
          layout,
          Stream.empty,
          undefined,
          () => {
            boundsSeen++;
            return QueryStream.empty<number>()(layout);
          },
          () => QueryStream.empty<number>()(layout, "desc"),
        );
        const deferred = QueryStream.defer(
          options,
          Effect.sync(() => {
            checks++;
            return inner;
          }),
        );
        const narrowed = QueryStream.narrow(deferred, {
          start: { keyValues: [1], inclusive: true },
        });
        const reversed = QueryStream.reverse(deferred);
        expect(checks).toBe(0);
        yield* Stream.runCollect(narrowed);
        yield* Stream.runCollect(narrowed);
        yield* Stream.runCollect(reversed);
        expect(checks).toBe(3);
        expect(boundsSeen).toBe(2);
      }),
  );

  it.effect.each(["direction", "layout"] as const)(
    "rejects a deferred %s mismatch before pulling its source",
    (mismatch) =>
      Effect.gen(function* () {
        let reads = 0;
        const actualLayout: QueryStreamKeyLayout.QueryStreamKeyLayout =
          mismatch === "layout"
            ? Result.getOrThrow(
                QueryStreamKeyLayout.fromIndex(["_creationTime"]),
              )
            : layout;
        const actualDirection: QueryStreamOrderDirection.QueryStreamOrderDirection =
          mismatch === "direction" ? "desc" : "asc";
        const source = new QueryStream.QueryStream(
          actualDirection,
          actualLayout,
          Stream.fromEffect(
            Effect.sync(() => {
              reads++;
              return new QueryStream.Element({
                doc: Option.some(1),
                keyValues: [1],
              });
            }),
          ),
        );
        const declaredDirection: QueryStreamOrderDirection.QueryStreamOrderDirection =
          "asc";
        const deferred = QueryStream.defer<
          number,
          QueryStreamKeyLabels.QueryStreamKeyLabels,
          QueryStreamOrderDirection.QueryStreamOrderDirection
        >(
          { keyLayout: layout, orderDirection: declaredDirection },
          Effect.succeed(source),
        );
        const defect = yield* Stream.runCollect(deferred).pipe(
          Effect.catchDefect(Effect.succeed),
        );
        expect(defect).toBeInstanceOf(QueryStream.DeferredStreamMismatchError);
        expect(defect).toMatchObject({
          _tag: "DeferredStreamMismatchError",
          expectedOrderDirection: "asc",
          actualOrderDirection: actualDirection,
          expectedKeyLayout: layout,
          actualKeyLayout: actualLayout,
        });
        expect(reads).toBe(0);
      }),
  );

  it.effect(
    "runs the deferred check once for each consumed flatMap inner stream",
    () =>
      Effect.gen(function* () {
        const checked: Array<number> = [];
        const rows = (values: ReadonlyArray<number>) =>
          new QueryStream.QueryStream(
            "asc",
            layout,
            Stream.fromIterable(values).pipe(
              Stream.map(
                (value) =>
                  new QueryStream.Element({
                    doc: Option.some(value),
                    keyValues: [value],
                  }),
              ),
            ),
          );
        const joined = rows([1, 2, 3]).pipe(
          QueryStream.flatMap(
            (value) =>
              QueryStream.defer(
                options,
                Effect.sync(() => {
                  checked.push(value);
                  return rows([value * 10]);
                }),
              ),
            { innerKeyLayout: layout },
          ),
        );
        expect(checked).toEqual([]);
        expect(yield* joined.pipe(Stream.take(2), Stream.runCollect)).toEqual([
          10, 20,
        ]);
        expect(checked).toEqual([1, 2]);
        expect(yield* Stream.runCollect(joined)).toEqual([10, 20, 30]);
        expect(checked).toEqual([1, 2, 1, 2, 3]);
      }),
  );

  it.effect("propagates a refused check before opening the source", () =>
    Effect.gen(function* () {
      const deferred = QueryStream.defer(
        options,
        Effect.fail("refused" as const),
      );
      expect(yield* Stream.runCollect(deferred).pipe(Effect.result)).toEqual(
        Result.fail("refused"),
      );
    }),
  );
});

describe("QueryStream cursor envelope", () => {
  it.effect(
    "rejects tampered and mismatched cursor envelopes before source reads and seals stable boundaries",
    () =>
      Effect.gen(function* () {
        const key = yield* Effect.promise(() =>
          crypto.subtle.importKey(
            "raw",
            new Uint8Array(32).fill(7),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          ),
        );
        const tag = (print: string, raw: string) =>
          Effect.promise(() =>
            crypto.subtle.sign(
              "HMAC",
              key,
              new TextEncoder().encode(`${print}.${raw}`),
            ),
          ).pipe(
            Effect.map((bytes) =>
              Buffer.from(bytes).toString("base64url").slice(0, 22),
            ),
          );
        const envelope = (print: string): QueryStream.CursorEnvelope => ({
          seal: (raw) =>
            tag(print, raw).pipe(Effect.map((mac) => `${print}.${mac}.${raw}`)),
          open: (sealed) =>
            Effect.gen(function* () {
              const first = sealed.indexOf(".");
              const second = sealed.indexOf(".", first + 1);
              if (first < 0 || second < 0) return Option.none();
              const claimed = sealed.slice(0, first);
              const given = sealed.slice(first + 1, second);
              const raw = sealed.slice(second + 1);
              return claimed === print && given === (yield* tag(claimed, raw))
                ? Option.some(raw)
                : Option.none();
            }),
        });
        const cursorEnvelope = envelope("f".repeat(22));
        const layout = Result.getOrThrow(
          QueryStreamKeyLayout.fromIndex(["_creationTime"]),
        );
        let reads = 0;
        const source = () =>
          new QueryStream.QueryStream(
            "desc",
            layout,
            Stream.fromIterable([1201, 1200]).pipe(
              Stream.map((time) => {
                reads++;
                return new QueryStream.Element({
                  doc: Option.some(time),
                  keyValues: [time, "session:campusA-d3-p1-b1-s1:2026-10-01"],
                });
              }),
            ),
          );
        const options = { cursor: null, numItems: 1 } as const;
        const raw = yield* QueryStream.paginate(source(), options);
        const sealed = yield* QueryStream.paginate(source(), {
          ...options,
          cursorEnvelope,
        });
        expect(Buffer.byteLength(raw.continueCursor)).toBe(101);
        expect(Buffer.byteLength(sealed.continueCursor)).toBe(147);
        const firstSeal = yield* cursorEnvelope.seal(raw.continueCursor);
        const secondSeal = yield* cursorEnvelope.seal(raw.continueCursor);
        expect(secondSeal).toBe(firstSeal);
        expect(firstSeal).toBe(sealed.continueCursor);
        const tampered =
          sealed.continueCursor.slice(0, 23) +
          "!" +
          sealed.continueCursor.slice(24);
        const stale = yield* envelope("s".repeat(22)).seal(raw.continueCursor);
        const farAhead =
          '{"runtimeLabels":["_creationTime","_id"],"keyValues":[1000000000000,"zzzz"]}';
        for (const crafted of [
          { cursor: tampered },
          { cursor: stale },
          { endCursor: farAhead },
          { endCursor: `${"f".repeat(22)}.${"A".repeat(22)}.${farAhead}` },
        ]) {
          reads = 0;
          const error = yield* QueryStream.paginate(source(), {
            ...options,
            ...crafted,
            cursorEnvelope,
          }).pipe(Effect.catchDefect(Effect.succeed));
          expect(error).toBeInstanceOf(ConvexError);
          expect(error).toMatchObject({
            data: { paginationError: "InvalidCursor" },
          });
          expect(reads).toBe(0);
        }
        const unchanged = yield* QueryStream.paginate(source(), {
          cursor: sealed.continueCursor,
          numItems: 0,
          cursorEnvelope,
        });
        expect(unchanged.continueCursor).toBe(sealed.continueCursor);
        const done = yield* QueryStream.paginate(source(), {
          cursor: sealed.continueCursor,
          numItems: 10,
          cursorEnvelope,
        });
        expect(done.isDone).toBe(true);
        expect(yield* cursorEnvelope.open(done.continueCursor)).toEqual(
          Option.some(QueryStreamCursor.END_CURSOR),
        );
        const pinned = yield* QueryStream.paginate(source(), {
          ...options,
          endCursor: done.continueCursor,
          cursorEnvelope,
        });
        expect(pinned.page).toEqual([1201, 1200]);
      }),
  );
});

it("QueryStream.paginate preserves envelope service requirements in both call forms", () => {
  type SealService = { readonly service: "seal" };
  const cursorEnvelope: QueryStream.CursorEnvelope<SealService> = {
    open: Effect.succeedSome,
    seal: Effect.succeed,
  };
  const source = QueryStream.empty<number>()(
    Result.getOrThrow(QueryStreamKeyLayout.fromIndex([])),
  );
  const options = { cursor: null, numItems: 1, cursorEnvelope } as const;
  const direct = QueryStream.paginate(source, options);
  const piped = source.pipe(QueryStream.paginate(options));
  expectTypeOf(direct).toEqualTypeOf<
    Effect.Effect<
      QueryStream.PaginationResult<number>,
      QueryStream.ReadBudgetExceededError,
      SealService
    >
  >();
  expectTypeOf(piped).toEqualTypeOf<typeof direct>();
});
