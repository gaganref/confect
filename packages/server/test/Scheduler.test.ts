import { GenericId as ScopedId, IdScope, Ref } from "@confect/core";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { makeFunctionReference } from "convex/server";
import * as Scheduler from "@confect/server/Scheduler";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import type { Scheduler as ConvexScheduler } from "convex/server";
import type { GenericId } from "convex/values";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vitest";

const scheduledFunctionId =
  "scheduled-function-id" as GenericId<"_scheduled_functions">;

describe("Scheduler", () => {
  it.effect("cancel delegates lazily with the scheduled function ID", () => {
    const cancel = vi.fn(() => Promise.resolve());
    const convexScheduler = {
      runAfter: () => Promise.resolve(scheduledFunctionId),
      runAt: () => Promise.resolve(scheduledFunctionId),
      cancel,
    } satisfies ConvexScheduler;

    return Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const cancellation = scheduler.cancel(scheduledFunctionId);

      expectTypeOf<typeof scheduler.cancel>()
        .parameter(0)
        .toEqualTypeOf<GenericId<"_scheduled_functions">>();
      expectTypeOf(cancellation).toEqualTypeOf<Effect.Effect<void>>();
      expect(cancel).not.toHaveBeenCalled();

      expect(yield* cancellation).toBeUndefined();
      expect(cancel).toHaveBeenCalledExactlyOnceWith(scheduledFunctionId);
      expect(cancel.mock.contexts[0]).toBe(convexScheduler);
    }).pipe(Effect.provide(Scheduler.layer(convexScheduler)));
  });

  it.effect("cancel preserves unexpected Convex failures as defects", () => {
    const failure = new Error("Convex cancellation failed");
    const convexScheduler = {
      runAfter: () => Promise.resolve(scheduledFunctionId),
      runAt: () => Promise.resolve(scheduledFunctionId),
      cancel: () => Promise.reject(failure),
    } satisfies ConvexScheduler;

    return Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const exit = yield* Effect.exit(scheduler.cancel(scheduledFunctionId));

      expect(exit).toEqual(Exit.die(failure));
    }).pipe(Effect.provide(Scheduler.layer(convexScheduler)));
  });

  it.effect(
    "cancels IDs from both scheduling methods in the component scope",
    () => {
      const scope = IdScope.component("@example/counter");
      const cancelled: Array<string> = [];
      const convexScheduler = {
        runAfter: () => Promise.resolve(scheduledFunctionId),
        runAt: () => Promise.resolve(scheduledFunctionId),
        cancel: (id) => {
          cancelled.push(id);
          return Promise.resolve();
        },
      } satisfies ConvexScheduler;
      const ref = Ref.fromFunctionReference(
        makeFunctionReference<"mutation", {}>("counter:tick"),
      );

      return Effect.gen(function* () {
        const scheduler = yield* Scheduler.forScope<typeof scope>();
        const after = yield* scheduler.runAfter(Duration.zero, ref);
        const at = yield* scheduler.runAt(DateTime.makeUnsafe(0), ref);
        expectTypeOf<typeof scheduler.cancel>()
          .parameter(0)
          .toEqualTypeOf<
            ScopedId.GenericId<"_scheduled_functions", typeof scope>
          >();
        expectTypeOf(scheduler.cancel(after)).toEqualTypeOf<
          Effect.Effect<void>
        >();
        yield* scheduler.cancel(after);
        yield* scheduler.cancel(at);
        expect(cancelled).toEqual([
          "scheduled-function-id",
          "scheduled-function-id",
        ]);
        const foreign = yield* Schema.decodeUnknownEffect(
          ScopedId.GenericId(
            "_scheduled_functions",
            IdScope.component("@example/other"),
          ),
        )("foreign-id");
        // @ts-expect-error Scheduled IDs from another component cannot be cancelled here.
        void scheduler.cancel(foreign);
        // @ts-expect-error Application scheduled IDs cannot be cancelled in a component.
        void scheduler.cancel(scheduledFunctionId);
        const documentId = yield* Schema.decodeUnknownEffect(
          ScopedId.GenericId("counters", scope),
        )("document-id");
        // @ts-expect-error A component document ID is not a scheduled-function ID.
        void scheduler.cancel(documentId);
      }).pipe(Effect.provide(Scheduler.layer(convexScheduler, scope)));
    },
  );
});
