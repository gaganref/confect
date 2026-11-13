import * as Str from "effect/String";
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
import * as CommandLine from "effect/process/CommandLine";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

class BackendNotReadyError extends Schema.TaggedError<
  BackendNotReadyError,
  { readonly brand: unique symbol }
>()("BackendNotReadyError", { message: Schema.String }) {}

class BackendVersionLookupError extends Schema.TaggedError<
  BackendVersionLookupError,
  { readonly brand: unique symbol }
>()("BackendVersionLookupError", { message: Schema.String }) {}

class BackendEnvironmentSetupError extends Schema.TaggedError<
  BackendEnvironmentSetupError,
  { readonly brand: unique symbol }
>()("BackendEnvironmentSetupError", {
  variable: Schema.String,
  exitCode: Schema.Finite,
}) {}

class BackendRedeployError extends Schema.TaggedError<
  BackendRedeployError,
  { readonly brand: unique symbol }
>()("BackendRedeployError", { exitCode: Schema.Finite }) {}

export class LocalBackend extends Context.Service<
  LocalBackend,
  {
    readonly client: ConvexHttpClient;
    readonly setEnv: (
      name: string,
      value: string,
    ) => Effect.Effect<void, BackendEnvironmentSetupError>;
    /**
     * Push the unchanged fixture code to the running backend again.
     */
    readonly redeploy: Effect.Effect<void, BackendRedeployError>;
  }
>()("confect-local-backend/LocalBackend") {}

const READY_LINE = "Convex functions ready!";

/**
 * The local backends' first port. Setting `CONFECT_LOCAL_BACKEND_PORT` moves
 * every backend this suite starts, so it can run beside another checkout's on
 * one machine. The default is the suite's fixed 3210.
 */
// oxlint-disable-next-line effecttsgo/process-env -- The port is read once, at module load before any Effect runs, as the fixed ports were.
const basePort = Number(process.env["CONFECT_LOCAL_BACKEND_PORT"] ?? 3210);

/**
 * Each backend's cloud port. Its site port is the next one.
 */
export const ports = {
  app: basePort,
  consumer: basePort + 10,
  plain: basePort + 20,
} as const;

/**
 * A backend's cloud URL.
 */
export const cloudUrl = (port: number = ports.app) =>
  `http://127.0.0.1:${port}`;

/**
 * `path` on a backend's site URL, where its HTTP actions answer.
 */
export const siteUrl = (path = "", port: number = ports.app) =>
  `http://127.0.0.1:${port + 1}${path}`;

// Knobs read by `crates/common/src/knobs.rs` in convex-backend. Lowering
// these shrinks `MAX_CACHE_AGE` (= `USER_TIMEOUT` + `SYSTEM_TIMEOUT` + 1s,
// per `crates/application/src/cache/mod.rs`) to ~7s so a single test run
// can wait past the cache eviction window.
const USER_TIMEOUT_SECONDS = 1;
const SYSTEM_TIMEOUT_SECONDS = 5;

/**
 * Duration after which a query whose handler observed time is evicted from the
 * local backend's reactive cache. Exported so tests can derive their sleep from
 * it rather than hard-coding a magic number.
 */
export const maxCacheAge = Duration.seconds(
  USER_TIMEOUT_SECONDS + SYSTEM_TIMEOUT_SECONDS + 1,
);

/**
 * Spawn `convex dev` from the shared `fixtures/` project with reduced UDF
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
  const setEnv = Effect.fn("LocalBackend.setEnv")(function* (
    name: string,
    value: string,
  ) {
    const words = ["pnpm", "convex", "env", "set", name, value];
    const spawnOptions = {
      cwd: fixturesDir,
      extendEnv: true,
      env: { CONVEX_AGENT_MODE: "anonymous" },
    };
    // `pnpm` is a `.cmd` shim on Windows, which only a shell can run, and a
    // shell takes the whole command line as one string.
    const windowsLine = yield* Effect.fromResult(
      CommandLine.join(words, { format: "windows" }),
    ).pipe(Effect.orDie);
    const command =
      process.platform === "win32"
        ? ChildProcess.make(windowsLine, { ...spawnOptions, shell: true })
        : ChildProcess.make(words[0]!, words.slice(1), spawnOptions);
    const code = yield* spawner.exitCode(command).pipe(Effect.orDie);
    if (code !== 0)
      return yield* BackendEnvironmentSetupError.make({
        variable: name,
        exitCode: code,
      });
  });

  const command = ChildProcess.make(
    `pnpm convex dev --typecheck=disable --codegen=disable --tail-logs=disable --local-cloud-port ${options.port} --local-site-port ${options.port + 1} --local-backend-version precompiled-2026-10-28-cccbade`,
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
        // Auth config reads env before the first successful deployment.
        Stream.tap((line) =>
          Effect.forEach(options.env, ([name, value]) =>
            Str.includes(name)(line) ? setEnv(name, value) : Effect.void,
          ),
        ),
        Stream.takeUntil((line) => Str.includes(READY_LINE)(line)),
        Stream.runFold(
          () => ({ readySeen: false, versionLookupFailed: false }),
          (state, line) => ({
            readySeen: Str.includes(READY_LINE)(line),
            versionLookupFailed:
              state.versionLookupFailed ||
              Str.includes("Failed to fetch latest backend version")(line) ||
              /version\.convex\.dev returned (?:429|5\d{2}):/.test(line),
          }),
        ),
      );

      if (readySeen) {
        for (const [name, value] of options.env) yield* setEnv(name, value);
        const redeploy = Effect.gen(function* () {
          const code = yield* spawner
            .exitCode(
              ChildProcess.make(
                `pnpm convex run --push --typecheck=disable --codegen=disable ${options.redeployFunction}`,
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
            return yield* BackendRedeployError.make({ exitCode: code });
        });
        return {
          client: new ConvexHttpClient(cloudUrl(options.port)),
          setEnv,
          redeploy,
        };
      }

      const exitCode = yield* handle.exitCode;
      if (exitCode !== 0 && versionLookupFailed) {
        return yield* BackendVersionLookupError.make({
          message: `convex dev exited with code ${exitCode} after a transient backend version lookup failure`,
        });
      }
      return yield* BackendNotReadyError.make({
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
          BackendNotReadyError.make({
            message: `convex dev did not print "${READY_LINE}" within 90s (cold-start binary download?)`,
          }),
        ),
    }),
  );
});

/**
 * @internal
 */
export const layer = Layer.effect(
  LocalBackend,
  make({
    directory: "../fixtures",
    port: ports.app,
    env: [
      [
        "TEST_AUTH_JWKS",
        `data:application/json;base64,${Buffer.from('{"keys":[]}').toString("base64")}`,
      ],
      ["COMPONENT_MARKER", "from-app"],
      ["COMPONENT_HOST_ONLY", "host-only"],
    ],
    redeployFunction: "groups/components:hasAuth",
  }),
).pipe(Layer.provide(NodeServices.layer));

/**
 * @internal
 */
export const consumerLayer = Layer.effect(
  LocalBackend,
  make({
    directory: "../.consumer",
    port: ports.consumer,
    env: [["INSTALL_MARKER", "declared-consumer"]],
    redeployFunction: "hello:greet",
  }),
).pipe(Layer.provide(NodeServices.layer));

/**
 * Plain Convex HTTP actions, with no Confect router in front, for probes of the
 * binary's own HTTP answers. It needs no codegen or seeding.
 *
 * @internal
 */
export const plainLayer = Layer.effect(
  LocalBackend,
  make({
    directory: "../fixtures/plain",
    port: ports.plain,
    env: [],
    redeployFunction: "probe:ping",
  }),
).pipe(Layer.provide(NodeServices.layer));
