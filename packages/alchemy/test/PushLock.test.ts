import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  PushLock,
  PushLockError,
  layer as lockLayer,
} from "../src/internal/PushLock";
import { deadPid } from "./fixtures/Processes";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Locks live in the user's cache so every checkout on the machine shares
// them: ~/.cache/confect/alchemy/locks on POSIX, %LOCALAPPDATA% on Windows.
const withHome = <A, E, R>(
  effect: (paths: {
    readonly home: string;
    readonly lockFile: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-lock-test-",
    });
    const locks =
      process.platform === "win32"
        ? path.join(home, "confect", "alchemy", "locks")
        : path.join(home, ".cache", "confect", "alchemy", "locks");
    yield* fs.makeDirectory(locks, { recursive: true });
    return yield* effect({
      home,
      lockFile: path.join(locks, "happy-otter-123.lock"),
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ HOME: home, LOCALAPPDATA: home }),
        ),
      ),
    );
  });

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      lockLayer({ timeout: "2 seconds" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("PushLock", () => {
  it.live(
    "waits for a lock another process holds and takes it once that process exits without releasing it",
    () =>
      withHome(({ lockFile }) =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const lock = yield* PushLock;
          // Another process takes the lock by the same protocol and exits
          // without releasing it, as a crashed push would.
          const holder = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                `const fs = require("node:fs");
const claim = process.argv[1] + ".other";
fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, token: "other" }));
fs.linkSync(claim, process.argv[1]);
fs.rmSync(claim);
console.log("held");
setTimeout(() => process.exit(0), 600);`,
                lockFile,
              ],
              { stdin: "ignore", stderr: "ignore" },
            ),
          );
          const held = yield* Deferred.make<void>();
          yield* holder.stdout.pipe(
            Stream.runForEach(() => Deferred.succeed(held, undefined)),
            Effect.forkScoped,
          );
          yield* Deferred.await(held);
          const exitedAt = yield* holder.exitCode.pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.forkScoped,
          );
          const enteredAt = yield* lock.withLock(
            "happy-otter-123",
            Clock.currentTimeMillis,
          );
          expect(enteredAt).toBeGreaterThanOrEqual(yield* Fiber.join(exitedAt));
        }),
      ).pipe(Effect.scoped, provide),
  );

  it.live("serialises pushes started from different checkouts", () =>
    withHome(({ home }) =>
      Effect.gen(function* () {
        const lock = yield* PushLock;
        const events: string[] = [];
        const push = (checkout: string) =>
          lock
            .withLock(
              "happy-otter-123",
              Effect.gen(function* () {
                events.push(`start ${checkout}`);
                yield* Effect.sleep("150 millis");
                events.push(`end ${checkout}`);
              }),
            )
            .pipe(
              Effect.provideService(AlchemyContext, {
                dotAlchemy: `${home}/${checkout}/.alchemy`,
                dev: false,
                adopt: false,
              }),
            );
        yield* Effect.all([push("a"), push("b")], {
          concurrency: "unbounded",
        });
        expect(events.map((event) => event.split(" ")[0])).toEqual([
          "start",
          "end",
          "start",
          "end",
        ]);
      }),
    ).pipe(provide),
  );

  it.live("breaks a lock left behind by a process that has exited", () =>
    withHome(({ lockFile }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lock = yield* PushLock;
        yield* fs.writeFileString(
          lockFile,
          serialize({ pid: yield* deadPid, token: "crashed" }),
        );
        expect(
          yield* lock.withLock("happy-otter-123", Effect.succeed("pushed")),
        ).toBe("pushed");
        expect(yield* fs.exists(lockFile)).toBe(false);
      }),
    ).pipe(provide),
  );

  it.live("fails with a typed timeout when the holder never releases", () =>
    withHome(({ lockFile }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lock = yield* PushLock;
        yield* fs.writeFileString(
          lockFile,
          serialize({ pid: process.pid, token: "other-fiber" }),
        );
        expect(
          yield* lock
            .withLock("happy-otter-123", Effect.void)
            .pipe(Effect.result),
        ).toEqual(
          Result.fail(
            new PushLockError({
              deploymentName: "happy-otter-123",
              reason: "timeout",
            }),
          ),
        );
      }),
    ).pipe(provide),
  );

  it("says which deployment's push lock failed and why", () => {
    expect(
      new PushLockError({
        deploymentName: "happy-otter-123",
        reason: "timeout",
      }).message,
    ).toBe(
      "Timed out waiting for another push to happy-otter-123 to release its push lock",
    );
  });

  it.live(
    "stops waiting promptly when interrupted and leaves the holder's lock",
    () =>
      withHome(({ lockFile }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const lock = yield* PushLock;
          const holder = serialize({ pid: process.pid, token: "other-fiber" });
          yield* fs.writeFileString(lockFile, holder);
          const waiting = yield* lock
            .withLock("happy-otter-123", Effect.void)
            .pipe(Effect.forkScoped);
          yield* Effect.sleep("200 millis");
          const before = yield* Clock.currentTimeMillis;
          yield* Fiber.interrupt(waiting);
          expect((yield* Clock.currentTimeMillis) - before).toBeLessThan(500);
          expect(yield* fs.readFileString(lockFile)).toBe(holder);
        }),
      ).pipe(Effect.scoped, provide),
  );

  it.live(
    "releases the lock and its claim when the locked work fails or is interrupted",
    () =>
      withHome(({ lockFile }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const lock = yield* PushLock;
          expect(
            yield* lock
              .withLock("happy-otter-123", Effect.fail("push failed"))
              .pipe(Effect.result),
          ).toEqual(Result.fail("push failed"));
          expect(yield* fs.exists(lockFile)).toBe(false);
          const entered = yield* Deferred.make<void>();
          const held = yield* lock
            .withLock(
              "happy-otter-123",
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          expect(yield* fs.exists(lockFile)).toBe(true);
          yield* Fiber.interrupt(held);
          expect(yield* fs.readDirectory(path.dirname(lockFile))).toEqual([]);
        }),
      ).pipe(Effect.scoped, provide),
  );
});
