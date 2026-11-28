import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConvexHttpClient } from "convex/browser";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
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
  variables: Schema.Array(Schema.String),
  exitCode: Schema.Finite,
  /**
   * The CLI's interleaved stdout and stderr.
   */
  output: Schema.String,
}) {}

class BackendRedeployError extends Schema.TaggedError<
  BackendRedeployError,
  { readonly brand: unique symbol }
>()("BackendRedeployError", { exitCode: Schema.Finite }) {}

class BackendOutputTimeoutError extends Schema.TaggedError<
  BackendOutputTimeoutError,
  { readonly brand: unique symbol }
>()("BackendOutputTimeoutError", {
  /**
   * What the CLI printed after the mark and still held, none of which matched.
   */
  output: Schema.Array(Schema.String),
}) {}

class BackendOutputEndedError extends Schema.TaggedError<
  BackendOutputEndedError,
  { readonly brand: unique symbol }
>()("BackendOutputEndedError", {
  /**
   * What the CLI printed after the mark and still held, none of which matched,
   * before its output ended.
   */
  output: Schema.Array(Schema.String),
}) {}

/**
 * What ends the reader of `convex dev`'s output with a failure: an environment
 * write it makes during startup. A failure of the output streams themselves
 * ends it as a defect.
 */
type ReaderError = BackendEnvironmentSetupError;

/**
 * How many of `convex dev`'s latest lines a backend holds for `awaitOutput`.
 * Older lines are dropped, and marks stay absolute.
 */
const OUTPUT_TAIL = 2000;

/**
 * The latest lines `convex dev` printed, `lines[0]` being line `start` of all
 * it printed.
 */
interface Output {
  readonly start: number;
  readonly lines: ReadonlyArray<string>;
}

const appendLine = (output: Output, line: string): Output =>
  output.lines.length < OUTPUT_TAIL
    ? { start: output.start, lines: Arr.append(output.lines, line) }
    : {
        start: output.start + 1,
        lines: Arr.append(Arr.drop(output.lines, 1), line),
      };

/**
 * The held lines from absolute line `mark` on.
 */
const linesFrom = (output: Output, mark: number): ReadonlyArray<string> =>
  Arr.drop(output.lines, Math.max(0, mark - output.start));

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
    /**
     * How many lines `convex dev` has printed, its watcher's push results
     * included: a mark to pass to `awaitOutput`.
     */
    readonly outputMark: Effect.Effect<number>;
    /**
     * The lines `convex dev` printed after `mark`, of its latest `OUTPUT_TAIL`,
     * once one of them matches, waiting up to `timeout`. It fails with what
     * ended the CLI's output if that ends first.
     */
    readonly awaitOutput: (
      mark: number,
      match: (line: string) => boolean,
      timeout?: Duration.Input,
    ) => Effect.Effect<
      ReadonlyArray<string>,
      BackendOutputTimeoutError | BackendOutputEndedError | ReaderError
    >;
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
  sync: basePort + 30,
  family: basePort + 40,
  guard: basePort + 50,
  declarations: basePort + 60,
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
 *
 * @internal
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly directory: string;
  readonly port: number;
  readonly env: ReadonlyArray<readonly [string, string]>;
  readonly redeployFunction: string;
}) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const parentScope = yield* Effect.scope;
  const fixturesDir = path.resolve(import.meta.dirname, options.directory);
  // Runs `pnpm convex <args>` once and keeps its interleaved stdout and
  // stderr, so a failure carries the CLI's own message.
  const convexCli = Effect.fnUntraced(
    function* (args: ReadonlyArray<string>, stdin?: string) {
      const words = ["pnpm", "convex", ...args];
      const spawnOptions = {
        cwd: fixturesDir,
        extendEnv: true,
        env: { CONVEX_AGENT_MODE: "anonymous" },
        ...(stdin === undefined
          ? {}
          : { stdin: Stream.make(new TextEncoder().encode(stdin)) }),
      };
      // `pnpm` is a `.cmd` shim on Windows, which only a shell can run, and a
      // shell takes the whole command line as one string.
      const windowsLine = yield* Effect.fromResult(
        CommandLine.join(words, { format: "windows" }),
      );
      const command =
        process.platform === "win32"
          ? ChildProcess.make(windowsLine, { ...spawnOptions, shell: true })
          : ChildProcess.make(words[0]!, words.slice(1), spawnOptions);
      const handle = yield* spawner.spawn(command);
      const output = yield* handle.all.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.forkScoped,
      );
      const exitCode = yield* handle.exitCode;
      // A descendant that outlives the CLI can hold the pipes open; keep what
      // arrived rather than wait on it.
      const text = yield* Fiber.join(output).pipe(
        Effect.timeoutOption("2 seconds"),
      );
      return { exitCode, output: Option.getOrElse(text, () => "") };
    },
    Effect.scoped,
    Effect.orDie,
  );

  const setEnv = Effect.fn("LocalBackend.setEnv")(function* (
    name: string,
    value: string,
  ) {
    const { exitCode, output } = yield* convexCli(["env", "set", name, value]);
    if (exitCode !== 0)
      return yield* BackendEnvironmentSetupError.make({
        variables: [name],
        exitCode,
        output,
      });
  });

  // Sets every configured variable in one `update_environment_variables`
  // request. The CLI reads the dotenv lines from stdin, skips values that are
  // already current and sends nothing when none changed. The fixed values here
  // contain no single quotes or line breaks.
  const setConfiguredEnv = Effect.gen(function* () {
    if (options.env.length === 0) return;
    const { exitCode, output } = yield* convexCli(
      ["env", "set", "--force"],
      Arr.join(
        Arr.map(options.env, ([name, value]) => `${name}='${value}'\n`),
        "",
      ),
    );
    if (exitCode !== 0)
      return yield* BackendEnvironmentSetupError.make({
        variables: Arr.map(options.env, ([name]) => name),
        exitCode,
        output,
      });
  }).pipe(Effect.withSpan("LocalBackend.setConfiguredEnv"));

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
      const startupEnvSet = yield* Ref.make(false);
      // The CLI's latest lines, read for its whole life, so a test can see
      // what its watcher printed for a push.
      const output = yield* Ref.make<Output>({ start: 0, lines: [] });
      // Ready, or how the reader ended before it: a failed environment write
      // fails startup with its own error rather than run into the timeout.
      const started = yield* Deferred.make<boolean, ReaderError>();
      // How the reader ended, which every later wait observes.
      const ended = yield* Deferred.make<void, ReaderError>();
      const reader: Effect.Effect<void, ReaderError> = Stream.merge(
        handle.stdout.pipe(Stream.decodeText(), Stream.splitLines),
        handle.stderr.pipe(Stream.decodeText(), Stream.splitLines),
      ).pipe(
        Stream.orDie,
        // A fresh deployment's first push fails while auth config or a
        // component reads a variable that is not yet set. `convex dev` then
        // retries the push when the deployment's variables change. Set them
        // all in one write on the first line that names one, and write
        // nothing more until the CLI reports ready: a second update
        // committed during that retried push fails with an OCC conflict
        // (#211).
        Stream.tap((line) =>
          Effect.gen(function* () {
            if (
              (yield* Deferred.isDone(started)) ||
              !Arr.some(options.env, ([name]) => Str.includes(name)(line)) ||
              (yield* Ref.getAndSet(startupEnvSet, true))
            )
              return;
            yield* setConfiguredEnv;
          }),
        ),
        Stream.runForEach((line) =>
          Ref.update(output, (held) => appendLine(held, line)).pipe(
            Effect.andThen(
              Str.includes(READY_LINE)(line)
                ? Deferred.succeed(started, true)
                : Effect.void,
            ),
          ),
        ),
      );
      yield* reader.pipe(
        Effect.onExit((exit) =>
          Effect.andThen(
            Exit.isFailure(exit)
              ? Deferred.failCause(started, exit.cause)
              : Deferred.succeed(started, false),
            Deferred.done(ended, Exit.asVoid(exit)),
          ),
        ),
        Effect.forkScoped,
      );
      const readySeen = yield* Deferred.await(started);
      const printed = yield* Ref.get(output);
      const versionLookupFailed = Arr.some(
        printed.lines,
        (line) =>
          Str.includes("Failed to fetch latest backend version")(line) ||
          /version\.convex\.dev returned (?:429|5\d{2}):/.test(line),
      );

      if (readySeen) {
        // Restore the defaults a previous suite may have replaced. No push is
        // in flight once the CLI reports ready.
        yield* setConfiguredEnv;
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
        const outputMark = Effect.map(
          Ref.get(output),
          (held) => held.start + held.lines.length,
        );
        const awaitOutput = Effect.fn("LocalBackend.awaitOutput")(function* (
          mark: number,
          match: (line: string) => boolean,
          timeout: Duration.Input = "90 seconds",
        ) {
          const after = Effect.map(Ref.get(output), (held) =>
            linesFrom(held, mark),
          );
          const poll: Effect.Effect<ReadonlyArray<string>> = after.pipe(
            Effect.filterOrElse(
              (lines) => Arr.some(lines, match),
              () => Effect.andThen(Effect.sleep("200 millis"), () => poll),
            ),
          );
          // The reader's end, a failure as itself, settles a wait that would
          // otherwise run into its timeout.
          const readerEnded = Deferred.await(ended).pipe(
            Effect.andThen(after),
            Effect.flatMap((lines) =>
              Effect.fail(BackendOutputEndedError.make({ output: lines })),
            ),
          );
          return yield* Effect.raceFirst(poll, readerEnded).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.flatMap(after, (lines) =>
                  Effect.fail(
                    BackendOutputTimeoutError.make({ output: lines }),
                  ),
                ),
            }),
          );
        });
        return {
          client: new ConvexHttpClient(cloudUrl(options.port)),
          setEnv,
          redeploy,
          outputMark,
          awaitOutput,
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

const emptyJwks = `data:application/json;base64,${Buffer.from('{"keys":[]}').toString("base64")}`;

/**
 * @internal
 */
export const layer = Layer.effect(
  LocalBackend,
  make({
    directory: "../fixtures",
    port: ports.app,
    env: [
      ["TEST_AUTH_JWKS", emptyJwks],
      ["COMPONENT_MARKER", "from-app"],
      ["COMPONENT_HOST_ONLY", "host-only"],
      ["FIRST_COMPONENT_REQUIRED", "first-required"],
      ["FIRST_COMPONENT_OPTIONAL", "first-optional"],
      ["FIRST_COMPONENT_MARKER", "from-app"],
      ["SECOND_COMPONENT_REQUIRED", "second-required"],
      ["SECOND_COMPONENT_OPTIONAL", "from-app"],
      ["SECOND_COMPONENT_MARKER", "from-app"],
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
 * Plain Convex functions and HTTP actions, with no Confect router in front, for
 * probes of the binary's own answers. It needs no codegen or seeding.
 *
 * @internal
 */
export const plainLayer = Layer.effect(
  LocalBackend,
  make({
    directory: "../fixtures/plain",
    port: ports.plain,
    // The JWT suite sets the JWKS its minted tokens need. Until then the
    // fixture's `auth.config.ts` declares an empty one.
    env: [["TEST_AUTH_JWKS", emptyJwks]],
    redeployFunction: "probe:ping",
  }),
).pipe(Layer.provide(NodeServices.layer));

/**
 * The sync probe's app (`fixtures/sync`), which the probe runs on this binary
 * and on the test kernel. Its `auth.config` reads `TEST_AUTH_JWKS`, which the
 * probe replaces with the JWKS of the tokens it mints.
 *
 * @internal
 */
export const syncLayer = Layer.effect(
  LocalBackend,
  make({
    directory: "../fixtures/sync",
    port: ports.sync,
    env: [
      [
        "TEST_AUTH_JWKS",
        `data:application/json;base64,${Buffer.from('{"keys":[]}').toString("base64")}`,
      ],
    ],
    redeployFunction: "sync:whoami",
  }),
).pipe(Layer.provide(NodeServices.layer));

/**
 * The provider family probe's app (`fixtures/family`), whose `auth.config`
 * expands `PEER_SERVICES`. It starts with one peer whose JWKS has no keys; the
 * suite sets the value its minted tokens need without pushing again.
 *
 * @internal
 */
export const familyLayer = Layer.effect(
  LocalBackend,
  make({
    directory: "../fixtures/family",
    port: ports.family,
    env: [
      [
        "PEER_SERVICES",
        `[{"name":"platform","issuer":"https://platform.confect.invalid","jwks":"${emptyJwks}"}]`,
      ],
    ],
    redeployFunction: "peers:read",
  }),
).pipe(Layer.provide(NodeServices.layer));

/**
 * The push check contract's app (`fixtures/guard`): a host and its mounted
 * component, whose manifest sections declare push checks that refuse the push a
 * `confect/verdict.ts` names. Its suite rewrites those files while the watcher
 * runs and restores them.
 *
 * @internal
 */
export const guardLayer = Layer.effect(
  LocalBackend,
  make({
    directory: "../fixtures/guard",
    port: ports.guard,
    env: [],
    redeployFunction: "probe:version",
  }),
).pipe(Layer.provide(NodeServices.layer));
