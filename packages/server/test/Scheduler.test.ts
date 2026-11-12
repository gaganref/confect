import * as Cause from "effect/Cause";
import { recording } from "./internal/recording";
import * as Forwarding from "./internal/forwarding";
import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import { GenericId as ScopedId, IdScope, Ref } from "@confect/core";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { makeFunctionReference } from "convex/server";
import * as Layer from "effect/Layer";
import * as Scheduler from "@confect/server/Scheduler";
import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
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
      const services = yield* Layer.build(Scheduler.layer(convexScheduler));
      return yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        const cancellation = scheduler.cancel(scheduledFunctionId);

        expectTypeOf<typeof scheduler.cancel>()
          .parameter(0)
          .toEqualTypeOf<GenericId<"_scheduled_functions">>();
        expectTypeOf(cancellation).toEqualTypeOf<Effect.Effect<void>>();
        expect(cancel).not.toHaveBeenCalled();

        const cancellationResult = yield* cancellation;
        expect(cancellationResult).toBeUndefined();
        expect(cancel).toHaveBeenCalledExactlyOnceWith(scheduledFunctionId);
        expect(cancel.mock.contexts[0]).toBe(convexScheduler);
      }).pipe(Effect.provideContext(services));
    }).pipe(Effect.scoped);
  });

  it.effect("cancel preserves unexpected Convex failures as defects", () => {
    const failure = new Error("Convex cancellation failed");
    const convexScheduler = {
      runAfter: () => Promise.resolve(scheduledFunctionId),
      runAt: () => Promise.resolve(scheduledFunctionId),
      cancel: () => Promise.reject(failure),
    } satisfies ConvexScheduler;

    return Effect.gen(function* () {
      const services = yield* Layer.build(Scheduler.layer(convexScheduler));
      return yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        const exit = yield* Effect.exit(scheduler.cancel(scheduledFunctionId));

        expect(exit).toEqual(Exit.die(failure));
      }).pipe(Effect.provideContext(services));
    }).pipe(Effect.scoped);
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

it.effect.each(Forwarding.cases)(
  "forwards with $label and ends both spans with the job ID",
  ({ forward, enabled }) => {
    const sent: Array<unknown> = [];
    const { spans, observability } = recording();
    const schedule = (_time: unknown, _ref: unknown, args?: unknown) => {
      sent.push(args);
      return Promise.resolve(scheduledFunctionId);
    };
    const native = {
      runAfter: schedule,
      runAt: schedule,
      cancel: () => Promise.resolve(),
    };
    return Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const [reserved] = Forwarding.mutations;
      const plain = Ref.fromFunctionReference(
        makeFunctionReference<"mutation", { count: number }>("items:plain"),
      );
      yield* scheduler.runAfter(Duration.zero, reserved, { count: 1 });
      yield* scheduler.runAt(DateTime.makeUnsafe(0), reserved, { count: 1 });
      yield* scheduler.runAfter(Duration.zero, plain, { count: 1 });
      expect(sent).toEqual([
        {
          count: "1",
          ...(enabled ? { context: { boundary: "Scheduler.runAfter" } } : {}),
        },
        {
          count: "1",
          ...(enabled ? { context: { boundary: "Scheduler.runAt" } } : {}),
        },
        { count: 1 },
      ]);
      expect(
        spans.map(({ name, status }) => [
          name,
          status._tag === "Ended" && status.exit,
        ]),
      ).toEqual([
        ["Scheduler.runAfter", Exit.succeed(scheduledFunctionId)],
        ["Scheduler.runAt", Exit.succeed(scheduledFunctionId)],
        ["Scheduler.runAfter", Exit.succeed(scheduledFunctionId)],
      ]);
    }).pipe(
      Effect.provide(Scheduler.layer(native)),
      Effect.provideService(RegisteredFunction.Forward, forward),
      Effect.provide(observability),
    );
  },
);

it.effect("ends a rejected scheduling span with the scheduling failure", () => {
  const failure = new Error("fixture schedule failure");
  const { spans, observability } = recording();
  const native = {
    runAfter: () => Promise.reject(failure),
    runAt: () => Promise.reject(failure),
    cancel: () => Promise.resolve(),
  };
  const target = Ref.fromFunctionReference(
    makeFunctionReference<"mutation", {}>("items:plain"),
  );
  return Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    yield* Effect.exit(scheduler.runAt(DateTime.makeUnsafe(0), target));
    const [span] = spans;
    assert(span?.status._tag === "Ended" && Exit.isFailure(span.status.exit));
    expect([span.name, Cause.squash(span.status.exit.cause)]).toEqual([
      "Scheduler.runAt",
      failure,
    ]);
  }).pipe(Effect.provide([Scheduler.layer(native), observability]));
});
