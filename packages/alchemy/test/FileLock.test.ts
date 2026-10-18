import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FileLock from "../src/internal/FileLock";
import { deadPid } from "./fixtures/Processes";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const staleLock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "confect-file-lock-",
  });
  const file = path.join(directory, "owner.lock");
  yield* fs.writeFileString(
    file,
    serialize({ pid: yield* deadPid, token: "dead" }),
  );
  return file;
});

describe("FileLock", () => {
  it.live("takes over a lock whose holder has exited without waiting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* staleLock;
      yield* Effect.gen(function* () {
        yield* FileLock.acquire(file);
        expect(yield* fs.readFileString(file)).toContain(
          `"pid":${process.pid}`,
        );
      }).pipe(Effect.scoped);
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "finishes removing a stale lock before it stops for an interruption",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* staleLock;
        const recovery = `${file}.recovery`;
        const entered = yield* Deferred.make<void>();
        const gate = Promise.withResolvers<void>();
        const runDetached = Effect.runPromiseWith(
          yield* Effect.context<never>(),
        );
        // Node cannot cancel an unlink it has started: interrupting the
        // effect abandons the callback while the removal still happens.
        const slowRemoval = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, (base) => ({
            ...base,
            remove: (
              target: string,
              options?: Parameters<typeof base.remove>[1],
            ) =>
              target === file
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(
                      Effect.callback<void>((resume) => {
                        void gate.promise
                          .then(() => runDetached(base.remove(target)))
                          .then(() => resume(Effect.void));
                      }),
                    ),
                  )
                : base.remove(target, options),
          })),
        ).pipe(Layer.provide(NodeServices.layer));
        const acquiring = yield* FileLock.acquire(file, "10 seconds").pipe(
          Effect.scoped,
          Effect.provide(Layer.merge(NodeServices.layer, slowRemoval)),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        const interrupting = yield* Fiber.interrupt(acquiring).pipe(
          Effect.forkChild,
        );
        yield* Effect.sleep("50 millis");
        expect(yield* fs.exists(recovery)).toBe(true);
        gate.resolve();
        yield* Fiber.join(interrupting);
        expect(yield* fs.exists(recovery)).toBe(false);
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
