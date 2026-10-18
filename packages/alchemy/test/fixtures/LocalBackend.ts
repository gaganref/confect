import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";

// Python's zipfile with ZIP_DEFLATED: convex-local-backend and
// convex-local-backend.exe, each "#!/bin/sh\necho local backend\n" x 20.
export const backendArchive = Buffer.from(
  "UEsDBBQAAAAIAEtUT13Bw602JgAAAEQCAAAUAAAAY29udmV4LWxvY2FsLWJhY2tlbmRTVtRPyszTL87gSk3OyFfIyU9OzFFISkzOTs1L4VIelRyVJCwJAFBLAwQUAAAACABLVE9dwcOtNiYAAABEAgAAGAAAAGNvbnZleC1sb2NhbC1iYWNrZW5kLmV4ZVNW1E/KzNMvzuBKTc7IV8jJT07MUUhKTM5OzUvhUh6VHJUkLAkAUEsBAhQDFAAAAAgAS1RPXcHDrTYmAAAARAIAABQAAAAAAAAAAAAAAIABAAAAAGNvbnZleC1sb2NhbC1iYWNrZW5kUEsBAhQDFAAAAAgAS1RPXcHDrTYmAAAARAIAABgAAAAAAAAAAAAAAIABWAAAAGNvbnZleC1sb2NhbC1iYWNrZW5kLmV4ZVBLBQYAAAAAAgACAIgAAAC0AAAAAAA=",
  "base64",
);

export interface ServedBackend {
  readonly args: ReadonlyArray<string>;
  readonly running: () => boolean;
  /**
   * Stop answering and exit with `code`, as a crashed backend would.
   */
  readonly exit: (code: number) => Effect.Effect<void>;
}

export interface FakeBehaviour {
  /**
   * Exit with this code at once instead of serving.
   */
  exitCode: number | undefined;
  /**
   * Answer `/instance_name` with this name instead of the backend's own.
   */
  answerAs: string | undefined;
  /**
   * Serve without ever answering, as a backend stuck before readiness.
   */
  silent: boolean;
}

/**
 * Stands in for the backend binary and the network. `keygen` prints a fresh
 * admin key per call; a served backend answers `/instance_name` on its port
 * until its scope closes; `answers` lets a test put another program on a port.
 * `behaviour` can change between boots, and `attempts` records the arguments of
 * every backend start, served or not. Node commands (codegen, `convex deploy`)
 * succeed and record the push target.
 */
export const fakeBackend = (options?: Partial<FakeBehaviour>) => {
  const behaviour: FakeBehaviour = {
    exitCode: options?.exitCode,
    answerAs: options?.answerAs,
    silent: options?.silent ?? false,
  };
  const served: ServedBackend[] = [];
  const spawned = Deferred.makeUnsafe<void>();
  const attempts: Array<ReadonlyArray<string>> = [];
  const pushes: string[] = [];
  const downloads: string[] = [];
  const answers = new Map<string, string>();
  let keys = 0;
  const spawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand")
            return yield* Effect.die("unexpected piped command");
          const args = command.args;
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          let stdout = Stream.empty as Stream.Stream<Uint8Array>;
          let stop = Effect.void;
          if (command.command === process.execPath) {
            if (args[1] === "deploy")
              pushes.push(
                yield* fs
                  .readFileString(args[args.indexOf("--env-file") + 1])
                  .pipe(Effect.orDie),
              );
            yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
          } else if (args[0] === "keygen") {
            keys++;
            const name = args[args.indexOf("--instance-name") + 1];
            stdout = Stream.make(
              new TextEncoder().encode(`${name}|0a1b2c${keys}\n`),
            );
            yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
          } else if (behaviour.exitCode !== undefined) {
            attempts.push(args);
            yield* Deferred.succeed(
              exited,
              ChildProcessSpawner.ExitCode(behaviour.exitCode),
            );
          } else {
            attempts.push(args);
            const origin = args[args.indexOf("--convex-origin") + 1];
            if (!behaviour.silent)
              answers.set(
                origin,
                behaviour.answerAs ?? args[args.indexOf("--instance-name") + 1],
              );
            let running = true;
            stop = Effect.sync(() => {
              running = false;
              answers.delete(origin);
            });
            served.push({
              args,
              running: () => running,
              exit: (code) =>
                stop.pipe(
                  Effect.andThen(
                    Deferred.succeed(
                      exited,
                      ChildProcessSpawner.ExitCode(code),
                    ),
                  ),
                  Effect.asVoid,
                ),
            });
            yield* Effect.addFinalizer(() =>
              stop.pipe(
                Effect.andThen(
                  Deferred.succeed(exited, ChildProcessSpawner.ExitCode(143)),
                ),
              ),
            );
            yield* Deferred.succeed(spawned, undefined);
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1000 + served.length),
            exitCode: Deferred.await(exited),
            isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
            kill: () =>
              stop.pipe(
                Effect.andThen(
                  Deferred.succeed(exited, ChildProcessSpawner.ExitCode(143)),
                ),
                Effect.asVoid,
              ),
            stdin: undefined as never,
            stdout,
            stderr: Stream.empty,
            all: stdout,
            getInputFd: () => undefined as never,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
      );
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      if (request.url.startsWith("https://github.com/")) {
        downloads.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(backendArchive)),
        );
      }
      const origin = new URL(request.url).origin;
      const name = answers.get(origin);
      return name === undefined
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          )
        : Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(name)),
          );
    }),
  );
  return {
    layer: Layer.mergeAll(spawner, http),
    behaviour,
    attempts,
    served,
    /**
     * Completes when the first backend is served.
     */
    spawned,
    pushes,
    downloads,
    answers,
  };
};
