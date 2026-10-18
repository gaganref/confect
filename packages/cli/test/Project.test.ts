import { expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Project from "./integration/Project";

it.effect("retries project cleanup without advancing the test clock", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const fs = FileSystem.makeNoop({
      makeTempDirectory: () => Effect.succeed("consumer"),
      makeDirectory: () => Effect.void,
      writeFileString: () => Effect.void,
      remove: () =>
        Effect.suspend(() => {
          attempts++;
          return attempts === 1
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Busy",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: "consumer",
                }),
              )
            : Effect.void;
        }),
    });
    const fiber = yield* Project.make.pipe(
      Effect.as("cleaned"),
      Effect.scoped,
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(NodePath.layer),
      Effect.forkChild,
    );
    const completed = yield* Fiber.join(fiber).pipe(
      Effect.timeoutOption("1 second"),
      TestClock.withLive,
    );
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(completed).toEqual(Option.some("cleaned"));
    expect(attempts).toBe(2);
  }),
);
