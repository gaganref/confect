import * as Table from "@confect/server/Table";
import * as QueryStreamIndexRange from "@confect/server/QueryStreamIndexRange";
import type * as QueryStreamKeyValues from "@confect/server/QueryStreamKeyValues";
import type * as QueryStreamOrderDirection from "@confect/server/QueryStreamOrderDirection";
import * as QueryStreamReadBudget from "@confect/server/QueryStreamReadBudget";
import { assert, describe, expect, it } from "@effect/vitest";
import * as QueryStream from "@confect/server/QueryStream";
import { compareValues, getDocumentSize } from "convex/values";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const table = Table.make(() => Schema.Struct({ group: Schema.String }))(
  "documents",
);
const distinctFields: ReadonlyArray<string> = ["group"];

const documents = [
  { _id: "a1", _creationTime: 1, group: "a" },
  { _id: "a2", _creationTime: 2, group: "a" },
  { _id: "b1", _creationTime: 3, group: "b" },
  { _id: "b2", _creationTime: 4, group: "b" },
];

interface RecordedConstraint {
  readonly _tag: "eq" | "gt" | "gte" | "lt" | "lte";
  readonly field: string;
  readonly value: QueryStreamKeyValues.KeyValue;
}

type Document = (typeof documents)[number];

interface ReaderRun {
  readonly order: QueryStreamOrderDirection.QueryStreamOrderDirection;
  next: number;
  returned: number;
  settled: number;
}

interface PendingRead {
  readonly iterator: number;
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly settled: Deferred.Deferred<void>;
}

const makeReader = (
  pending?: PendingRead,
  rows: ReadonlyArray<Document> = documents,
) => {
  let documentsRead = 0;
  const runs: Array<ReaderRun> = [];
  const events: Array<string> = [];
  const reader: QueryStream.ReflectionReader = {
    query: () => ({
      withIndex: (_indexName, indexRange) => {
        const operations: Array<RecordedConstraint> = [];
        const record =
          (_tag: RecordedConstraint["_tag"]) =>
          (field: string, value: RecordedConstraint["value"]) => {
            operations.push({ _tag, field, value });
            return builder;
          };
        const builder = {
          eq: record("eq"),
          gt: record("gt"),
          gte: record("gte"),
          lt: record("lt"),
          lte: record("lte"),
        };
        indexRange?.(builder);
        return {
          order: (order) => ({
            [Symbol.asyncIterator]: () => {
              const id = runs.length;
              const run: ReaderRun = {
                order,
                next: 0,
                returned: 0,
                settled: 0,
              };
              runs.push(run);
              events.push(`${id}:open:${order}`);
              const matching = rows.filter((document) =>
                operations.every(({ _tag, field, value }) => {
                  if (
                    field !== "group" &&
                    field !== "_creationTime" &&
                    field !== "_id"
                  ) {
                    throw new Error(`Unexpected index field: ${field}`);
                  }
                  const comparison = compareValues(document[field], value);
                  switch (_tag) {
                    case "eq":
                      return comparison === 0;
                    case "gt":
                      return comparison > 0;
                    case "gte":
                      return comparison >= 0;
                    case "lt":
                      return comparison < 0;
                    case "lte":
                      return comparison <= 0;
                  }
                }),
              );
              if (order === "desc") matching.reverse();
              let position = 0;
              const result = (): IteratorResult<Document> => {
                run.settled++;
                const value = matching[position++];
                if (value !== undefined) documentsRead++;
                return value === undefined
                  ? { done: true, value: undefined }
                  : { done: false, value };
              };
              return {
                next: () => {
                  run.next++;
                  events.push(`${id}:next`);
                  if (pending?.iterator === id) {
                    Deferred.doneUnsafe(pending.entered, Effect.void);
                    return Effect.runPromise(
                      Deferred.await(pending.release),
                    ).then(() => {
                      const value = result();
                      Deferred.doneUnsafe(pending.settled, Effect.void);
                      return value;
                    });
                  }
                  return Promise.resolve(result());
                },
                return: () => {
                  run.returned++;
                  events.push(`${id}:return`);
                  return Promise.resolve({
                    done: true as const,
                    value: undefined,
                  });
                },
              };
            },
          }),
        };
      },
    }),
  };
  const stream = QueryStream.fromReflection<Document, "asc">({
    reader,
    table,
    indexName: "by_group",
    indexFieldPaths: ["group", "_creationTime"],
    indexRange: QueryStreamIndexRange.builder<
      Document,
      ["group", "_creationTime"]
    >(),
    orderDirection: "asc",
  });
  return {
    stream,
    runs,
    events,
    get documentsRead() {
      return documentsRead;
    },
  };
};

describe("QueryStream iterator lifecycle", () => {
  it.effect.each(["maximumRowsRead", "maximumBytesRead"] as const)(
    "rejects invalid %s before starting a database read",
    (field) =>
      Effect.gen(function* () {
        for (const value of [-1, 0.5, NaN, Infinity, -Infinity]) {
          const reader = makeReader();
          const exit = yield* QueryStream.paginate(reader.stream, {
            cursor: null,
            numItems: 10,
            [field]: value,
          }).pipe(Effect.exit);
          assert(Exit.isFailure(exit));
          const error = Result.getOrThrow(Cause.findDefect(exit.cause));
          assert(error instanceof QueryStream.InvalidReadLimitError);
          expect(Schema.isSchemaError(error.cause)).toBe(true);
          expect(error.message).toContain(field);
          expect(reader.runs).toEqual([]);
          expect(reader.events).toEqual([]);
        }
      }),
  );

  it.effect(
    "preserves the page budget during nested public stream consumption",
    () =>
      Effect.gen(function* () {
        const outer = makeReader();
        const inner = makeReader();
        const stream = outer.stream.pipe(
          QueryStream.mapEffect((document) =>
            Stream.runCollect(inner.stream).pipe(
              Effect.map((nested) => ({ document, nested })),
            ),
          ),
        );

        const page = yield* QueryStream.paginate(stream, {
          cursor: null,
          numItems: 10,
          maximumRowsRead: 2,
        });

        expect(page.page).toEqual([
          { document: documents[0], nested: [documents[0]] },
        ]);
        expect(page.pageStatus).toBe("SplitRequired");
        expect(outer.runs).toEqual([
          { order: "asc", next: 1, returned: 1, settled: 1 },
        ]);
        expect(inner.runs).toEqual([
          { order: "asc", next: 2, returned: 1, settled: 2 },
        ]);
        expect(
          Option.isNone(
            yield* Effect.serviceOption(
              QueryStreamReadBudget.QueryStreamReadBudget,
            ),
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "restores the enclosing budget after successful and failed pagination",
    () =>
      Effect.gen(function* () {
        const enclosing = yield* QueryStreamReadBudget.make(
          yield* Schema.decodeEffect(QueryStreamReadBudget.Limits)({
            maximumRowsRead: 10,
          }),
        );
        const reader = makeReader();

        yield* Effect.gen(function* () {
          const page = yield* QueryStream.paginate(reader.stream, {
            cursor: null,
            numItems: 10,
            maximumRowsRead: 1,
          });
          expect(page.page).toEqual([documents[0]]);
          expect(yield* QueryStreamReadBudget.QueryStreamReadBudget).toBe(
            enclosing,
          );

          const error = yield* QueryStream.paginate(reader.stream, {
            cursor: null,
            numItems: 10,
            maximumRowsRead: 0,
          }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(QueryStream.ReadBudgetExceededError);
          expect(yield* QueryStreamReadBudget.QueryStreamReadBudget).toBe(
            enclosing,
          );
        }).pipe(
          Effect.provideService(
            QueryStreamReadBudget.QueryStreamReadBudget,
            enclosing,
          ),
        );

        expect((yield* enclosing.getReadCounts).rowsRead).toBe(0);
        expect(
          Option.isNone(
            yield* Effect.serviceOption(
              QueryStreamReadBudget.QueryStreamReadBudget,
            ),
          ),
        ).toBe(true);
      }),
  );

  it.effect.each(["maximumRowsRead", "maximumBytesRead"] as const)(
    "reports the counted lookahead when %s is zero",
    (limit) =>
      Effect.gen(function* () {
        const reader = makeReader();
        const error = yield* QueryStream.paginate(reader.stream, {
          cursor: null,
          numItems: 10,
          [limit]: 0,
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(QueryStream.ReadBudgetExceededError);
        expect(error).toMatchObject({ rowsRead: 1, bytesRead: 42 });
        expect(reader.runs).toEqual([
          { order: "asc", next: 1, returned: 1, settled: 1 },
        ]);
      }),
  );

  it.effect("isolates budget limits and status across page executions", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const reader = makeReader({ iterator: 0, entered, release, settled });
      const budgeted = QueryStream.paginate(reader.stream, {
        cursor: null,
        numItems: 10,
        maximumRowsRead: 1,
      });
      const pending = yield* budgeted.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);

      const unlimited = yield* QueryStream.paginate(reader.stream, {
        cursor: null,
        numItems: 3,
      });
      expect(unlimited.page).toEqual(documents.slice(0, 3));
      expect(unlimited.pageStatus).toBeUndefined();

      yield* Deferred.succeed(release, undefined);
      const first = yield* Fiber.join(pending);
      expect(first.page).toEqual([documents[0]]);
      expect(first.pageStatus).toBe("SplitRequired");

      const repeated = yield* budgeted;
      expect(repeated).toEqual(first);
      expect(reader.runs).toEqual([
        { order: "asc", next: 2, returned: 1, settled: 2 },
        { order: "asc", next: 3, returned: 1, settled: 3 },
        { order: "asc", next: 2, returned: 1, settled: 2 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("closes a budget-protected leaf when the page succeeds early", () =>
    Effect.gen(function* () {
      const reader = makeReader();
      const page = yield* QueryStream.paginate(reader.stream, {
        cursor: null,
        numItems: 1,
        maximumRowsRead: 10,
      });

      expect(page.page).toEqual([documents[0]]);
      expect(reader.runs).toEqual([
        { order: "asc", next: 1, returned: 1, settled: 1 },
      ]);
      expect(reader.events).toEqual(["0:open:asc", "0:next", "0:return"]);
    }),
  );

  it.effect(
    "closes reverse distinct discovery before opening its representative probe",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const head = yield* reader.stream.pipe(
          QueryStream.distinct(distinctFields),
          QueryStream.reverse,
          Stream.runHead,
        );

        expect(head).toEqual(Option.some(documents[2]));
        expect(reader.runs).toEqual([
          { order: "desc", next: 1, returned: 1, settled: 1 },
          { order: "asc", next: 1, returned: 1, settled: 1 },
        ]);
        expect(reader.events).toEqual([
          "0:open:desc",
          "0:next",
          "0:return",
          "1:open:asc",
          "1:next",
          "1:return",
        ]);
      }),
  );

  it.effect(
    "closes both short-lived readers when reverse distinct pagination succeeds early",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const page = yield* reader.stream.pipe(
          QueryStream.distinct(distinctFields),
          QueryStream.reverse,
          QueryStream.paginate({
            cursor: null,
            numItems: 1,
            maximumRowsRead: 10,
          }),
        );

        expect(page.page).toEqual([documents[2]]);
        expect(reader.events).toEqual([
          "0:open:desc",
          "0:next",
          "0:return",
          "1:open:asc",
          "1:next",
          "1:return",
        ]);
      }),
  );

  it.effect(
    "stops a representative probe at its first unfiltered document",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const head = yield* reader.stream.pipe(
          QueryStream.filter((document) => document._id !== "b1"),
          QueryStream.distinct(distinctFields),
          QueryStream.reverse,
          Stream.runHead,
        );

        expect(head).toEqual(Option.some(documents[3]));
        expect(reader.runs).toEqual([
          { order: "desc", next: 1, returned: 1, settled: 1 },
          { order: "asc", next: 2, returned: 1, settled: 2 },
        ]);
        expect(reader.events).toEqual([
          "0:open:desc",
          "0:next",
          "0:return",
          "1:open:asc",
          "1:next",
          "1:next",
          "1:return",
        ]);
      }),
  );

  it.effect(
    "retains the first probe key when its entire group is filtered out",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const reversed = reader.stream.pipe(
          QueryStream.filter((document) => document.group !== "b"),
          QueryStream.distinct(distinctFields),
          QueryStream.reverse,
        );
        const head = yield* Stream.runHead(reversed.annotated).pipe(
          Effect.provideServiceEffect(
            QueryStreamReadBudget.QueryStreamReadBudget,
            QueryStreamReadBudget.make({
              maximumRowsRead: Option.none(),
              maximumBytesRead: Option.none(),
            }),
          ),
        );

        expect(head).toEqual(
          Option.some(
            new QueryStream.Element({
              doc: Option.none(),
              keyValues: ["b", 3, "b1"],
            }),
          ),
        );
        expect(reader.runs).toEqual([
          { order: "desc", next: 1, returned: 1, settled: 1 },
          { order: "asc", next: 3, returned: 1, settled: 3 },
        ]);
        expect(reader.events).toEqual([
          "0:open:desc",
          "0:next",
          "0:return",
          "1:open:asc",
          "1:next",
          "1:next",
          "1:next",
          "1:return",
        ]);
      }),
  );

  it.effect(
    "closes the leaf when its read budget produces a partial page",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const page = yield* QueryStream.paginate(reader.stream, {
          cursor: null,
          numItems: 10,
          maximumRowsRead: 2,
        });

        expect(page.page).toEqual(documents.slice(0, 2));
        expect(page.isDone).toBe(false);
        expect(reader.runs).toEqual([
          { order: "asc", next: 3, returned: 1, settled: 3 },
        ]);
      }),
  );

  it.effect(
    "closes reverse discovery when the budget cannot fund a representative",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const error = yield* reader.stream.pipe(
          QueryStream.distinct(distinctFields),
          QueryStream.reverse,
          QueryStream.paginate({
            cursor: null,
            numItems: 10,
            maximumRowsRead: 1,
          }),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(QueryStream.ReadBudgetExceededError);
        expect(error).toMatchObject({ rowsRead: 2 });
        expect(reader.events).toEqual([
          "0:open:desc",
          "0:next",
          "0:return",
          "1:open:asc",
          "1:next",
          "1:return",
        ]);
      }),
  );

  it.effect(
    "closes a representative probe when filtering exhausts its budget",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const error = yield* reader.stream.pipe(
          QueryStream.filter((document) => document._id !== "b1"),
          QueryStream.distinct(distinctFields),
          QueryStream.reverse,
          QueryStream.paginate({
            cursor: null,
            numItems: 10,
            maximumRowsRead: 2,
          }),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(QueryStream.ReadBudgetExceededError);
        expect(error).toMatchObject({ rowsRead: 3 });
        expect(reader.events).toEqual([
          "0:open:desc",
          "0:next",
          "0:return",
          "1:open:asc",
          "1:next",
          "1:next",
          "1:return",
        ]);
      }),
  );

  it.effect.each([
    "leaf",
    "reverse discovery",
    "representative probe",
  ] as const)(
    "releases %s while next is pending and ignores its later resolution",
    (stage) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const iterator = stage === "representative probe" ? 1 : 0;
        const reader = makeReader({ iterator, entered, release, settled });
        const examined: Array<string> = [];
        let processed = 0;
        const observed = reader.stream.pipe(
          QueryStream.filterEffect((document) =>
            Effect.sync(() => {
              examined.push(document._id);
              return true;
            }),
          ),
        );
        const stream =
          stage === "leaf"
            ? observed
            : observed.pipe(
                QueryStream.distinct(distinctFields),
                QueryStream.reverse,
              );
        const fiber = yield* stream.pipe(
          QueryStream.mapEffect((document) =>
            Effect.sync(() => {
              processed++;
              return document;
            }),
          ),
          QueryStream.paginate({
            cursor: null,
            numItems: 10,
            maximumRowsRead: 10,
          }),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);
        expect(reader.runs[iterator]).toMatchObject({
          next: 1,
          returned: 0,
          settled: 0,
        });
        yield* Fiber.interrupt(fiber);
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        expect(reader.runs).toHaveLength(iterator + 1);
        for (const run of reader.runs) expect(run.returned).toBe(1);
        expect(reader.runs[iterator]?.settled).toBe(0);
        expect(processed).toBe(0);
        expect(examined).toEqual(iterator === 1 ? ["b2"] : []);
        const eventsAfterInterruption = [...reader.events];

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(settled);
        expect(reader.runs[iterator]?.settled).toBe(1);
        expect(reader.events).toEqual(eventsAfterInterruption);
        expect(processed).toBe(0);
        expect(examined).toEqual(iterator === 1 ? ["b2"] : []);
      }).pipe(Effect.scoped),
  );
});

describe("QueryStream.collect", () => {
  it.effect("collects every row when the row count equals the budget", () =>
    Effect.gen(function* () {
      const reader = makeReader();
      expect(
        yield* QueryStream.collect(reader.stream, { maximumRowsRead: 4 }),
      ).toEqual(documents);
      expect(reader.documentsRead).toBe(4);
      expect(reader.runs).toEqual([
        { order: "asc", next: 5, returned: 1, settled: 5 },
      ]);
    }),
  );

  it.effect("finishes pagination when the row count equals the budget", () =>
    Effect.gen(function* () {
      const reader = makeReader();
      const page = yield* QueryStream.paginate(reader.stream, {
        cursor: null,
        numItems: 10,
        maximumRowsRead: 4,
      });
      expect(page.page).toEqual(documents);
      expect(page.isDone).toBe(true);
      expect(page.pageStatus).toBeUndefined();
      expect(reader.documentsRead).toBe(4);
      expect(reader.runs).toEqual([
        { order: "asc", next: 5, returned: 1, settled: 5 },
      ]);
    }),
  );

  it.effect("collects every row when the byte count equals the budget", () =>
    Effect.gen(function* () {
      const rows = documents.slice(0, 3);
      expect(rows.reduce((sum, row) => sum + getDocumentSize(row), 0)).toBe(
        126,
      );
      const reader = makeReader(undefined, rows);
      expect(
        yield* QueryStream.collect(reader.stream, { maximumBytesRead: 126 }),
      ).toEqual(rows);
      expect(reader.documentsRead).toBe(3);
      expect(reader.runs).toEqual([
        { order: "asc", next: 4, returned: 1, settled: 4 },
      ]);
    }),
  );

  it.effect("finishes pagination when the byte count equals the budget", () =>
    Effect.gen(function* () {
      const reader = makeReader(undefined, documents.slice(0, 3));
      const page = yield* QueryStream.paginate(reader.stream, {
        cursor: null,
        numItems: 10,
        maximumBytesRead: 126,
      });
      expect(page.page).toEqual(documents.slice(0, 3));
      expect(page.isDone).toBe(true);
      expect(page.pageStatus).toBeUndefined();
      expect(reader.documentsRead).toBe(3);
      expect(reader.runs).toEqual([
        { order: "asc", next: 4, returned: 1, settled: 4 },
      ]);
    }),
  );

  it.effect(
    "counts a byte-limit lookahead without returning a partial collection",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const error = yield* QueryStream.collect(reader.stream, {
          maximumBytesRead: 126,
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ReadBudgetExceededError",
          rowsRead: 4,
          bytesRead: 168,
        });
        expect(reader.documentsRead).toBe(4);
      }),
  );

  it.effect("counts a byte-limit lookahead without emitting it in a page", () =>
    Effect.gen(function* () {
      const reader = makeReader();
      const page = yield* QueryStream.paginate(reader.stream, {
        cursor: null,
        numItems: 10,
        maximumBytesRead: 126,
      });
      expect(page.page).toEqual(documents.slice(0, 3));
      expect(page.isDone).toBe(false);
      expect(page.pageStatus).toBe("SplitRequired");
      expect(reader.documentsRead).toBe(4);
    }),
  );

  it.effect.each(["maximumRowsRead", "maximumBytesRead"] as const)(
    "completes an empty stream but refuses one row under zero %s",
    (limit) =>
      Effect.gen(function* () {
        const empty = makeReader(undefined, []);
        expect(
          yield* QueryStream.collect(empty.stream, { [limit]: 0 }),
        ).toEqual([]);
        expect(empty.documentsRead).toBe(0);
        const emptyPage = yield* QueryStream.paginate(empty.stream, {
          cursor: null,
          numItems: 10,
          [limit]: 0,
        });
        expect(emptyPage.page).toEqual([]);
        expect(emptyPage.isDone).toBe(true);
        expect(empty.documentsRead).toBe(0);
        const one = makeReader(undefined, documents.slice(0, 1));
        const error = yield* QueryStream.collect(one.stream, {
          [limit]: 0,
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ReadBudgetExceededError",
          rowsRead: 1,
          bytesRead: 42,
        });
        expect(one.documentsRead).toBe(1);
        const pageError = yield* QueryStream.paginate(one.stream, {
          cursor: null,
          numItems: 10,
          [limit]: 0,
        }).pipe(Effect.flip);
        expect(pageError).toMatchObject({
          _tag: "ReadBudgetExceededError",
          rowsRead: 1,
          bytesRead: 42,
        });
        expect(one.documentsRead).toBe(2);
      }),
  );

  it.effect(
    "collects a complete small stream and refuses an over-budget stream",
    () =>
      Effect.gen(function* () {
        const rows = (count: number) =>
          Array.from({ length: count }, (_, i) => ({
            _id: `row${i}`,
            _creationTime: i,
            group: "a",
          }));
        const holidays = makeReader(undefined, rows(40));
        expect(
          yield* QueryStream.collect(holidays.stream, {
            maximumRowsRead: 2_000,
          }),
        ).toHaveLength(40);
        expect(holidays.documentsRead).toBe(40);
        const demands = makeReader(undefined, rows(2_001));
        let returned = false;
        const error = yield* QueryStream.collect(demands.stream, {
          maximumRowsRead: 2_000,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              returned = true;
            }),
          ),
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "ReadBudgetExceededError",
          rowsRead: 2_001,
        });
        expect(returned).toBe(false);
        expect(demands.documentsRead).toBe(2_001);
        expect(demands.runs.every((run) => run.returned === 1)).toBe(true);
      }),
  );

  it.effect(
    "counts filtered rows and never turns a budget stop into an empty success",
    () =>
      Effect.gen(function* () {
        const reader = makeReader();
        const error = yield* reader.stream.pipe(
          QueryStream.filter(() => false),
          QueryStream.collect({ maximumRowsRead: 2 }),
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "ReadBudgetExceededError",
          rowsRead: 3,
        });
      }),
  );
});

it.effect("QueryStream.collect respects an enclosing read budget", () =>
  Effect.gen(function* () {
    const reader = makeReader();
    const budget = yield* QueryStreamReadBudget.make(
      yield* Schema.decodeEffect(QueryStreamReadBudget.Limits)({
        maximumRowsRead: 2,
      }),
    );
    const error = yield* QueryStream.collect(reader.stream).pipe(
      Effect.provideService(
        QueryStreamReadBudget.QueryStreamReadBudget,
        budget,
      ),
      Effect.flip,
    );
    expect(error).toMatchObject({
      _tag: "ReadBudgetExceededError",
      rowsRead: 3,
    });
    expect(reader.documentsRead).toBe(3);
    expect(yield* budget.isStopped).toBe(true);
  }),
);

it.effect(
  "splits rare-filter pages at the default read budget and honors explicit larger limits",
  () =>
    Effect.gen(function* () {
      const rows = Array.from({ length: 24_000 }, (_, i) => ({
        _id: `mark${i}`,
        _creationTime: i + 1,
        group: "a",
      }));
      const rare = (reader: ReturnType<typeof makeReader>) =>
        reader.stream.pipe(
          QueryStream.filter(
            (doc) =>
              doc._creationTime >= 3 && (doc._creationTime - 3) % 1_200 === 0,
          ),
        );
      const unbudgeted = makeReader(undefined, rows);
      expect(
        yield* rare(unbudgeted).pipe(Stream.take(20), Stream.runCollect),
      ).toHaveLength(20);
      expect(unbudgeted.documentsRead).toBe(22_803);
      const reader = makeReader(undefined, rows);
      const first = yield* QueryStream.paginate(rare(reader), {
        cursor: null,
        numItems: 20,
      });
      expect(first.page).toHaveLength(2);
      expect(first.pageStatus).toBe("SplitRequired");
      expect(reader.documentsRead).toBe(2_001);
      const second = yield* QueryStream.paginate(rare(reader), {
        cursor: first.continueCursor,
        numItems: 20,
      });
      expect(second.pageStatus).toBe("SplitRequired");
      expect(reader.documentsRead).toBe(4_002);
      expect(second.continueCursor).not.toBe(first.continueCursor);
      const override = makeReader(undefined, rows);
      expect(
        (yield* QueryStream.paginate(rare(override), {
          cursor: null,
          numItems: 20,
          maximumRowsRead: 30_000,
        })).page,
      ).toHaveLength(20);
      expect(override.documentsRead).toBe(22_803);
      const collector = makeReader(undefined, rows);
      const error = yield* QueryStream.collect(collector.stream).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "ReadBudgetExceededError",
        rowsRead: 2_001,
      });
      expect(collector.documentsRead).toBe(2_001);
    }),
);

it.effect.each(["collect", "paginate"] as const)(
  "completes %s at exactly the default 2,000 row budget",
  (sink) =>
    Effect.gen(function* () {
      const rows = Array.from({ length: 2_000 }, (_, i) => ({
        _id: `row${i}`,
        _creationTime: i,
        group: "a",
      }));
      const reader = makeReader(undefined, rows);
      if (sink === "collect") {
        expect(yield* QueryStream.collect(reader.stream)).toEqual(rows);
      } else {
        const result = yield* QueryStream.paginate(reader.stream, {
          cursor: null,
          numItems: 2_001,
        });
        expect(result.page).toEqual(rows);
        expect(result.isDone).toBe(true);
        expect(result.pageStatus).toBeUndefined();
      }
      expect(reader.documentsRead).toBe(2_000);
    }),
);
