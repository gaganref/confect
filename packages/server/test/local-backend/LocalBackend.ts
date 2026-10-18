import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConvexHttpClient } from "convex/browser";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

class BackendNotReadyError extends Schema.TaggedError<BackendNotReadyError>()(
  "BackendNotReadyError",
  { message: Schema.String },
) {}

class BackendVersionLookupError extends Schema.TaggedError<BackendVersionLookupError>()(
  "BackendVersionLookupError",
  { message: Schema.String },
) {}

class BackendEnvironmentSetupError extends Schema.TaggedError<BackendEnvironmentSetupError>()(
  "BackendEnvironmentSetupError",
  { name: Schema.String, exitCode: Schema.Finite },
) {}

class BackendRedeployError extends Schema.TaggedError<BackendRedeployError>()(
  "BackendRedeployError",
  { exitCode: Schema.Finite },
) {}

export class LocalBackend extends Context.Service<
  LocalBackend,
  {
    readonly client: ConvexHttpClient;
    /**
     * Push the unchanged fixture code to the running backend again.
     */
    readonly redeploy: Effect.Effect<void, BackendRedeployError>;
  }
>()("@confect/server/test/local-backend/LocalBackend") {}

const READY_LINE = "Convex functions ready!";

// Knobs read by `crates/common/src/knobs.rs` in convex-backend. Lowering
// these shrinks `MAX_CACHE_AGE` (= `USER_TIMEOUT` + `SYSTEM_TIMEOUT` + 1s,
// per `crates/application/src/cache/mod.rs`) to ~3s so a single test run
// can wait past the cache eviction window.
const USER_TIMEOUT_SECONDS = 1;
const SYSTEM_TIMEOUT_SECONDS = 1;

/**
 * Duration after which a query whose handler observed time is evicted from the
 * local backend's reactive cache. Exported so tests can derive their sleep from
 * it rather than hard-coding a magic number.
 */
export const maxCacheAge = Duration.seconds(
  USER_TIMEOUT_SECONDS + SYSTEM_TIMEOUT_SECONDS + 1,
);

/**
 * Spawn `convex dev` from `test/local-backend/fixtures/` with reduced UDF
 * timeouts. The CLI keeps the local backend alive for the lifetime of the scope
 * and is signalled on scope close; the `ConvexHttpClient` is shared by every
 * test case.
 *
 * `.convex/` and `.env.local` are intentionally preserved between runs so the
 * CLI takes the "existing deployment" path and skips boilerplate codegen that
 * would otherwise overwrite committed fixture files.
 */
const make = Effect.fnUntraced(function* (options: {
  readonly directory: string;
  readonly port: number;
  readonly env: ReadonlyArray<readonly [string, string]>;
  readonly redeployFunction: string;
}) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const parentScope = yield* Effect.scope;
  const fixturesDir = path.resolve(import.meta.dirname, options.directory);

  const command = ChildProcess.make(
    "pnpm",
    [
      "convex",
      "dev",
      "--typecheck=disable",
      "--codegen=disable",
      "--tail-logs=disable",
      "--local-cloud-port",
      String(options.port),
      "--local-site-port",
      String(options.port + 1),
      "--local-backend-version",
      "precompiled-2026-10-06-a3538c6",
    ],
    {
      cwd: fixturesDir,
      // `pnpm` is a `.cmd` shim on Windows, which `spawn` cannot execute
      // directly.
      shell: true,
      // Without extendEnv, `env` replaces the child's entire environment and
      // `pnpm` falls off PATH.
      extendEnv: true,
      env: {
        CONVEX_AGENT_MODE: "anonymous",
        DATABASE_UDF_USER_TIMEOUT_SECONDS: USER_TIMEOUT_SECONDS.toString(),
        DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS: SYSTEM_TIMEOUT_SECONDS.toString(),
      },
    },
  );

  return yield* Effect.gen(function* () {
    const attemptScope = yield* Scope.fork(parentScope);
    return yield* Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const { readySeen, versionLookupFailed } = yield* Stream.merge(
        handle.stdout.pipe(Stream.decodeText(), Stream.splitLines),
        handle.stderr.pipe(Stream.decodeText(), Stream.splitLines),
      ).pipe(
        Stream.takeUntil((line) => line.includes(READY_LINE)),
        Stream.runFold(
          () => ({ readySeen: false, versionLookupFailed: false }),
          (state, line) => ({
            readySeen: line.includes(READY_LINE),
            versionLookupFailed:
              state.versionLookupFailed ||
              line.includes("Failed to fetch latest backend version") ||
              /version\.convex\.dev returned (?:429|5\d{2}):/.test(line),
          }),
        ),
      );

      if (readySeen) {
        for (const [name, value] of options.env) {
          const code = yield* spawner.exitCode(
            ChildProcess.make("pnpm", ["convex", "env", "set", name, value], {
              cwd: fixturesDir,
              shell: true,
              extendEnv: true,
              env: { CONVEX_AGENT_MODE: "anonymous" },
            }),
          );
          if (code !== 0)
            return yield* new BackendEnvironmentSetupError({
              name,
              exitCode: code,
            });
        }
        const redeploy = Effect.gen(function* () {
          const code = yield* spawner
            .exitCode(
              ChildProcess.make(
                "pnpm",
                [
                  "convex",
                  "run",
                  "--push",
                  "--typecheck=disable",
                  "--codegen=disable",
                  options.redeployFunction,
                ],
                {
                  cwd: fixturesDir,
                  shell: true,
                  extendEnv: true,
                  env: { CONVEX_AGENT_MODE: "anonymous" },
                },
              ),
            )
            .pipe(Effect.orDie);
          if (code !== 0)
            return yield* new BackendRedeployError({ exitCode: code });
        });
        return {
          client: new ConvexHttpClient(`http://127.0.0.1:${options.port}`),
          redeploy,
        };
      }

      const exitCode = yield* handle.exitCode;
      if (exitCode !== 0 && versionLookupFailed) {
        return yield* new BackendVersionLookupError({
          message: `convex dev exited with code ${exitCode} after a transient backend version lookup failure`,
        });
      }
      return yield* new BackendNotReadyError({
        message: `convex dev exited with code ${exitCode} before printing "${READY_LINE}"`,
      });
    }).pipe(
      Scope.provide(attemptScope),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void,
      ),
    );
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "BackendVersionLookupError",
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.jittered,
        Schedule.upTo({ times: 2 }),
      ),
    }),
    Effect.timeoutOrElse({
      duration: "90 seconds",
      orElse: () =>
        Effect.fail(
          new BackendNotReadyError({
            message: `convex dev did not print "${READY_LINE}" within 90s (cold-start binary download?)`,
          }),
        ),
    }),
  );
});

export const layer = Layer.effect(
  LocalBackend,
  make({
    directory: "./fixtures",
    port: 3210,
    env: [
      ["COMPONENT_MARKER", "from-app"],
      ["COMPONENT_HOST_ONLY", "host-only"],
    ],
    redeployFunction: "groups/components:hasAuth",
  }),
).pipe(Layer.provide(NodeServices.layer));

export const consumerLayer = Layer.effect(
  LocalBackend,
  make({
    directory: "./.consumer",
    port: 3220,
    env: [["INSTALL_MARKER", "declared-consumer"]],
    redeployFunction: "hello:greet",
  }),
).pipe(Layer.provide(NodeServices.layer));
