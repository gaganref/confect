import * as NodePath from "@effect/platform-node/NodePath";
import { expect, layer } from "@effect/vitest";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/**
 * A `ChildProcessSpawner` that plays `convex dev` printing `dev` and, when
 * `devEnds`, exiting, while `convex env set` exits with `envSetExit`. Every
 * other command exits 0 silently.
 */
const fakeSpawner = (script: {
  readonly dev: ReadonlyArray<string>;
  readonly devEnds: boolean;
  readonly envSetExit: number;
}) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { command: name, args } = command as ChildProcess.StandardCommand;
      const words = Arr.join([name, ...Arr.map(args, String)], " ");
      const dev = Str.includes("convex dev")(words);
      const envSet = Str.includes("env set")(words);
      const printed = Stream.make(
        new TextEncoder().encode(
          Arr.join(
            Arr.map(
              dev ? script.dev : envSet ? ["invalid variable"] : [],
              (line) => `${line}\n`,
            ),
            "",
          ),
        ),
      );
      const stdout =
        dev && !script.devEnds ? Stream.concat(printed, Stream.never) : printed;
      const exitCode = dev
        ? script.devEnds
          ? Effect.succeed(0)
          : Effect.never
        : Effect.succeed(envSet ? script.envSetExit : 0);
      return ChildProcessSpawner.makeHandle({
        pid: 1 as never,
        exitCode: exitCode as never,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain as never,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain as never,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void) as never,
      });
    }),
  );

const start = (script: Parameters<typeof fakeSpawner>[0]) =>
  LocalBackend.make({
    directory: "../fixtures",
    port: 3999,
    env: [["FAKE_VARIABLE", "value"]],
    redeployFunction: "probe:version",
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      fakeSpawner(script),
    ),
  );

layer(NodePath.layer, { excludeTestServices: true })(
  "LocalBackend.make",
  (it) => {
    it.effect(
      "fails startup with the environment write's own error, before any timeout",
      () =>
        Effect.gen(function* () {
          const exit = yield* start({
            dev: ["✖ FAKE_VARIABLE is used in auth.config.ts but is not set"],
            devEnds: false,
            envSetExit: 1,
          }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(Exit.isFailure(exit) ? exit.cause.toString() : "").toContain(
            "BackendEnvironmentSetupError",
          );
        }),
    );

    it.effect(
      "fails a wait for output with the output's end once convex dev exits after it was ready",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.gen(function* () {
            const backend = yield* start({
              dev: ["✔ Convex functions ready!"],
              devEnds: true,
              envSetExit: 0,
            });
            const mark = yield* backend.outputMark;
            return yield* backend.awaitOutput(mark, () => false, "30 seconds");
          }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.flip);
          expect(error._tag).toBe("BackendOutputEndedError");
        }),
    );
  },
);
