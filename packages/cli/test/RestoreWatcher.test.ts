import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RestoreWatcher from "@confect/cli/RestoreWatcher";

const watchConfect = (
  onEvent: (event: FileSystem.WatchEvent) => Effect.Effect<void>,
) =>
  FileSystem.FileSystem.use((fs) =>
    fs.watch("confect", { recursive: true }).pipe(Stream.runForEach(onEvent)),
  );

it.effect(
  "releases the recursive watch across restore and resumes after failure",
  () =>
    Effect.gen(function* () {
      let active = 0;
      const acquisitions = yield* Queue.unbounded<number>();
      const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
      let emit = (event: FileSystem.WatchEvent) =>
        Effect.asVoid(Queue.offer(events, event));
      const fs = FileSystem.makeNoop({
        watch: () =>
          Stream.callback<FileSystem.WatchEvent>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                active++;
                emit = (event) => Effect.asVoid(Queue.offer(queue, event));
              }).pipe(Effect.andThen(() => Queue.offer(acquisitions, active))),
              () =>
                Effect.sync(() => {
                  active--;
                }),
            ),
          ),
      });
      const watcher = yield* RestoreWatcher.make(
        watchConfect((event) => Queue.offer(events, event).pipe(Effect.asVoid)),
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      expect(yield* Queue.take(acquisitions)).toBe(1);
      const result = yield* Effect.gen(function* () {
        yield* watcher.duringRestore;
        expect(active).toBe(0);
        yield* emit({ _tag: "Remove", path: "_generated/schema.ts" });
        return yield* Effect.fail("rejected");
      }).pipe(Effect.scoped, Effect.flip);
      expect(result).toBe("rejected");
      expect(yield* Queue.take(acquisitions)).toBe(1);
      yield* emit({ _tag: "Create", path: "notes.spec.ts" });
      expect(yield* Queue.take(events)).toEqual({
        _tag: "Create",
        path: "notes.spec.ts",
      });
      expect(yield* Queue.clear(events)).toEqual([]);
      yield* Effect.gen(function* () {
        yield* watcher.duringRestore;
        expect(active).toBe(0);
      }).pipe(Effect.scoped);
      expect(yield* Queue.take(acquisitions)).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect("propagates watcher acquisition defects after resume", () =>
  Effect.gen(function* () {
    let starts = 0;
    const acquired = yield* Queue.unbounded<void>();
    const fs = FileSystem.makeNoop({
      watch: () =>
        Stream.unwrap(
          Effect.sync(() => {
            starts++;
            return starts === 1
              ? Stream.callback<FileSystem.WatchEvent>(() =>
                  Queue.offer(acquired, undefined),
                )
              : Stream.die("watcher acquisition failed");
          }),
        ),
    });
    const watcher = yield* RestoreWatcher.make(
      watchConfect(() => Effect.void),
    ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    yield* Queue.take(acquired);
    yield* watcher.duringRestore.pipe(Effect.scoped);
    const fiber = yield* watcher.failure.pipe(
      Effect.exit,
      Effect.timeoutOption("1 second"),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toEqual(
      Option.some(Exit.die("watcher acquisition failed")),
    );
    expect(starts).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("propagates cleanup defects when the watcher is paused", () =>
  Effect.gen(function* () {
    const acquired = yield* Queue.unbounded<void>();
    const fs = FileSystem.makeNoop({
      watch: () =>
        Stream.callback<FileSystem.WatchEvent>(() =>
          Effect.acquireRelease(Queue.offer(acquired, undefined), () =>
            Effect.die("watcher cleanup failed"),
          ),
        ),
    });
    const watcher = yield* RestoreWatcher.make(
      watchConfect(() => Effect.void),
    ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    yield* Queue.take(acquired);
    yield* watcher.duringRestore.pipe(Effect.scoped);
    const fiber = yield* watcher.failure.pipe(
      Effect.exit,
      Effect.timeoutOption("1 second"),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    const outcome = yield* Fiber.join(fiber);
    assert(Option.isSome(outcome));
    assert(Exit.isFailure(outcome.value));
    expect(Cause.findDie(outcome.value.cause)).toMatchObject({
      _tag: "Success",
      success: { defect: "watcher cleanup failed" },
    });
  }).pipe(Effect.scoped),
);
