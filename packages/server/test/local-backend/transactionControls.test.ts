import { getFunctionReference } from "@confect/core/RefInternal";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestConfect } from "../../../test/src/index";
import { boundary } from "../mock-backend/kernelBoundaries";
import refs from "./fixtures/confect/_generated/refs";
import registry from "./fixtures/confect/_generated/testing";
import * as LocalBackend from "./LocalBackend";

const functions = refs.public.groups.transactions;

type Metrics = Record<string, { used: number; remaining: number }>;

/**
 * Run `program` on a fresh test kernel loaded with the same fixture.
 */
const onKernel = <A, E>(
  program: (
    test: TestConfect.TestConfect<typeof registry.schema>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* program(
      yield* TestConfect.TestConfect<typeof registry.schema>(),
    );
  }).pipe(Effect.provide(TestConfect.layer(registry, { target: "kernel" })));

layer(LocalBackend.layer, { timeout: "120 seconds" })(
  "transaction controls",
  (it) => {
    it.effect("enforces nested query limits in queries and mutations", () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const caseId = "read-limits";
        yield* Effect.promise(() =>
          client.mutation(getFunctionReference(functions.seed), {
            caseId,
            count: 2,
          }),
        );
        expect(
          yield* Effect.promise(() =>
            client.query(getFunctionReference(functions.limitedRead), {
              caseId,
              limit: 10,
            }),
          ),
        ).toEqual(["seed-0", "seed-1"]);
        expect(
          yield* Effect.promise(() =>
            client.mutation(
              getFunctionReference(functions.limitedReadFromMutation),
              { caseId, limit: 10 },
            ),
          ),
        ).toEqual(["seed-0", "seed-1"]);
        yield* Effect.promise(() =>
          expect(
            client.query(getFunctionReference(functions.limitedRead), {
              caseId,
              limit: 1,
            }),
          ).rejects.toThrow(/documents read/i),
        );
        yield* Effect.promise(() =>
          expect(
            client.mutation(
              getFunctionReference(functions.limitedReadFromMutation),
              { caseId, limit: 1 },
            ),
          ).rejects.toThrow(/documents read/i),
        );
      }),
    );

    it.effect("enforces nested mutation write limits", () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const caseId = "write-limits";
        yield* Effect.promise(() =>
          client.mutation(getFunctionReference(functions.seed), {
            caseId,
            count: 0,
          }),
        );
        yield* Effect.promise(() =>
          expect(
            client.mutation(getFunctionReference(functions.limitedWrite), {
              caseId,
              limit: 0,
            }),
          ).rejects.toThrow(
            "Too many writes in a single function execution (limit: 0)",
          ),
        );
        expect(
          yield* Effect.promise(() =>
            client.query(getFunctionReference(functions.limitedRead), {
              caseId,
              limit: 10,
            }),
          ),
        ).toEqual([]);
        yield* Effect.promise(() =>
          client.mutation(getFunctionReference(functions.limitedWrite), {
            caseId,
            limit: 1,
          }),
        );
        expect(
          yield* Effect.promise(() =>
            client.query(getFunctionReference(functions.limitedRead), {
              caseId,
              limit: 10,
            }),
          ),
        ).toEqual(["child"]);
      }),
    );

    it.effect(
      "decodes a nested mutation error and rolls back only its writes",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const caseId = "rollback";
          yield* Effect.promise(() =>
            client.mutation(getFunctionReference(functions.seed), {
              caseId,
              count: 0,
            }),
          );
          expect(
            yield* Effect.promise(() =>
              client.mutation(getFunctionReference(functions.rollback), {
                caseId,
              }),
            ),
          ).toBe(true);
          expect(
            yield* Effect.promise(() =>
              client.query(getFunctionReference(functions.limitedRead), {
                caseId,
                limit: 10,
              }),
            ),
          ).toEqual(["parent"]);
        }),
    );

    it.effect(
      "answers getMetrics for one fixed workload as the test kernel does, apart from the SystemTableReadIntervals boundary",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const systemReads = boundary("SystemTableReadIntervals");
          expect(systemReads.probe).toBe(
            `transactionControls.test.ts > ${expect.getState().currentTestName}`,
          );
          const caseId = "metrics";
          yield* Effect.promise(() =>
            client.mutation(getFunctionReference(functions.seed), {
              caseId,
              count: 3,
            }),
          );
          const binary = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(functions.metrics), {
              caseId,
            }),
          );
          const kernel = yield* onKernel((test) =>
            test
              .mutation(functions.seed, { caseId, count: 3 })
              .pipe(
                Effect.andThen(test.mutation(functions.metrics, { caseId })),
              ),
          );
          const { rootMutationStart, firstNestedCall } = systemReads.measured;
          // Every metric but `databaseQueries` is equal.
          const besides = ({ databaseQueries: _, ...rest }: Metrics) => rest;
          expect(besides(kernel.start)).toEqual(besides(binary.start));
          expect(besides(kernel.end)).toEqual(besides(binary.end));
          // `databaseQueries` differs by the boundary's system share: the
          // root mutation's at the start, and its first nested call's too by
          // the end. No read covers an inserted ID, so neither count saturates.
          expect(kernel.start.databaseQueries!.used).toBe(0);
          expect(binary.start.databaseQueries!.used).toBe(
            kernel.start.databaseQueries!.used + rootMutationStart!,
          );
          expect(binary.end.databaseQueries!.used).toBe(
            kernel.end.databaseQueries!.used +
              rootMutationStart! +
              firstNestedCall!,
          );
          expect(kernel.end.documentsRead!.used).toBeGreaterThan(0);
          expect(kernel.end.databaseQueries!.used).toBeGreaterThan(0);
        }),
    );

    it.effect(
      "saturates databaseQueries when a read covers inserted IDs, as the test kernel does",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const { rootMutationStart } = boundary(
            "SystemTableReadIntervals",
          ).measured;
          const caseId = "inserted-intervals";
          yield* Effect.promise(() =>
            client.mutation(getFunctionReference(functions.seed), {
              caseId,
              count: 0,
            }),
          );
          const binary = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(functions.insertedIntervals), {
              caseId,
              count: 100,
            }),
          );
          const kernel = yield* onKernel((test) =>
            test.mutation(functions.insertedIntervals, { caseId, count: 100 }),
          );
          // Inserts count nothing. Reading one inserted ID drops the count by
          // the index's 100 intervals, saturating at zero on both targets, and
          // adds 100 back. Scanning `by_id` merges them into one.
          expect(kernel).toEqual({
            afterInserts: 0,
            afterGet: 100,
            afterScan: 1,
          });
          expect(binary).toEqual({
            afterInserts: rootMutationStart!,
            afterGet: 100,
            afterScan: 1,
          });
        }),
    );

    it.effect(
      "keeps the caller's scheduling counters in a stale-snapshot query, as the test kernel does",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const binary = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(functions.staleMetrics), {}),
          );
          const kernel = yield* onKernel((test) =>
            test.mutation(functions.staleMetrics, {}),
          );
          // The stale query's clone reads the system tables afresh, the
          // boundary's share again; every other metric is equal.
          const { staleSnapshotQueryStart } = boundary(
            "SystemTableReadIntervals",
          ).measured;
          const { databaseQueries: kernelQueries, ...kernelRest } = kernel;
          const { databaseQueries: binaryQueries, ...binaryRest } = binary;
          expect(kernelRest).toEqual(binaryRest);
          expect(kernelQueries!.used).toBe(0);
          expect(binaryQueries!.used).toBe(
            kernelQueries!.used + staleSnapshotQueryStart!,
          );
          expect(binary.functionsScheduled).toEqual({
            used: 1,
            remaining: 999,
          });
          expect(binary.scheduledFunctionArgsBytes!.used).toBe(4);
        }),
    );

    it.effect(
      "counts a pending commit timestamp patched to the largest int64 as a write, as the test kernel does",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const caseId = "max-after-pending";
          const binary = yield* Effect.promise(() =>
            client.mutation(
              getFunctionReference(refs.public.groups.commitTs.maxAfterPending),
              { caseId },
            ),
          );
          const kernel = yield* onKernel((test) =>
            test.mutation(refs.public.groups.commitTs.maxAfterPending, {
              caseId,
            }),
          );
          expect(binary).toEqual({
            written: 2,
            stored: "bigint",
            value: "9223372036854775807",
          });
          expect(kernel).toEqual(binary);
        }),
    );

    it.effect(
      "uses the mutation's pending writes unless a stale snapshot is requested",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          for (const stale of [false, true]) {
            const caseId = `stale-${stale}`;
            yield* Effect.promise(() =>
              client.mutation(getFunctionReference(functions.seed), {
                caseId,
                count: 1,
              }),
            );
            const values = yield* Effect.promise(() =>
              client.mutation(getFunctionReference(functions.staleRead), {
                caseId,
                stale,
              }),
            );
            if (stale) {
              expect(values).not.toContain("uncommitted");
            } else {
              expect(values).toEqual(["seed-0", "uncommitted"]);
            }
          }
        }),
    );
  },
);
