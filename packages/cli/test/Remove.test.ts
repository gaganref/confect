import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { remove } from "@confect/cli/Remove";

const busy = PlatformError.systemError({
  _tag: "Busy",
  module: "FileSystem",
  method: "remove",
  pathOrDescriptor: "generated",
});

it.effect("retries a busy removal until it succeeds", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const fs = FileSystem.makeNoop({
      remove: () =>
        Effect.suspend(() => {
          attempts++;
          return attempts < 3 ? Effect.fail(busy) : Effect.void;
        }),
    });
    const fiber = yield* remove("generated").pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(attempts).toBe(3);
  }),
);

it.effect("reports the path and bounded attempts when Busy persists", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const fs = FileSystem.makeNoop({
      remove: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(busy);
        }),
    });
    const fiber = yield* remove("generated").pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "RemoveBusyError",
      path: "generated",
      attempts: 4,
      cause: busy,
    });
    expect(attempts).toBe(4);
  }),
);

it.effect("does not retry other filesystem errors", () =>
  Effect.gen(function* () {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "remove",
    });
    let attempts = 0;
    const fs = FileSystem.makeNoop({
      remove: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(denied);
        }),
    });
    expect(
      yield* remove("generated").pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.flip,
      ),
    ).toEqual(denied);
    expect(attempts).toBe(1);
  }),
);
