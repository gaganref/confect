import * as NodeServices from "./fixtures/NodeTestServices";
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

const serialize = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.orDie,
  );

const staleLock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "confect-file-lock-",
  });
  const file = path.join(directory, "owner.lock");
  const serializeResult = yield* serialize({
    pid: yield* deadPid,
    token: "dead",
  });
  yield* fs.writeFileString(file, serializeResult);
  return file;
});

describe("FileLock", () => {
  it.live("takes over a lock whose holder has exited without waiting", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* staleLock;
        yield* Effect.gen(function* () {
          yield* FileLock.acquire(file);
          const fileContents = yield* fs.readFileString(file);
          expect(fileContents).toContain(`"pid":${process.pid}`);
        }).pipe(Effect.scoped);
        const fileExists = yield* fs.exists(file);
        expect(fileExists).toBe(false);
      }).pipe(Effect.scoped, Effect.provideContext(services));
    }),
  );

  it.live(
    "finishes removing a stale lock before it stops for an interruption",
    () =>
      Effect.gen(function* () {
        const services2 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const file = yield* staleLock;
          const recovery = `${file}.recovery`;
          const entered = yield* Deferred.make<void>();
          const gate = Promise.withResolvers<void>();
          const context2 = yield* Effect.context<never>();
          const runDetached = Effect.runPromiseWith(context2);
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
          const acquiring = yield* Effect.gen(function* () {
            const services3 = yield* Layer.build(
              Layer.merge(NodeServices.layer, slowRemoval),
            );
            return yield* FileLock.acquire(file, "10 seconds").pipe(
              Effect.scoped,
              Effect.provideContext(services3),
            );
          }).pipe(Effect.scoped, Effect.forkChild);
          yield* Deferred.await(entered);
          const interrupting = yield* Fiber.interrupt(acquiring).pipe(
            Effect.forkChild,
          );
          yield* Effect.sleep("50 millis");
          const recoveryExists = yield* fs.exists(recovery);
          expect(recoveryExists).toBe(true);
          gate.resolve();
          yield* Fiber.join(interrupting);
          const recoveryExists2 = yield* fs.exists(recovery);
          expect(recoveryExists2).toBe(false);
          const fileExists = yield* fs.exists(file);
          expect(fileExists).toBe(false);
        }).pipe(Effect.scoped, Effect.provideContext(services2));
      }),
  );
});
