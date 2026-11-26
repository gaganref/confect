import type * as ManifestSection from "@confect/core/ManifestSection";
import * as Str from "effect/String";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { stripVTControlCharacters } from "node:util";
import * as Redaction from "./Redaction.js";

export interface PrepareCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The kind of deployment a push goes to, which `prepare` hands its command as
 * `CONFECT_DEPLOYMENT_KIND`, so `confect codegen` reads it through any
 * wrapper.
 */
export type DeploymentKind = Exclude<ManifestSection.DeploymentKind, "unknown">;

/**
 * Where a push goes: a cloud deployment through its deploy key, or a local
 * backend through the CLI's self-hosted target and its admin key.
 */
export type PushTarget =
  | {
      readonly _tag: "Cloud";
      readonly deploymentName: string;
      readonly deployKey: Redacted.Redacted<string>;
    }
  | {
      readonly _tag: "SelfHosted";
      readonly deploymentName: string;
      readonly url: string;
      readonly adminKey: Redacted.Redacted<string>;
    };

/**
 * The variables `convex deploy` selects its deployment and its credentials
 * with, all set so the push goes to `target` alone. The CLI fills a variable
 * from the project's `.env.local` and `.env` only when the process leaves it
 * unset, and treats an empty one as absent, so an empty value here keeps the
 * project's files from choosing another deployment or credential. The key
 * travels only in the child's environment, never in a file.
 */
const selection = (
  target: PushTarget,
): Record<string, string | Redacted.Redacted<string>> => ({
  CONVEX_DEPLOY_KEY: target._tag === "Cloud" ? target.deployKey : "",
  CONVEX_DEPLOYMENT_TOKEN: "",
  CONVEX_DEPLOYMENT: "",
  CONVEX_SELF_HOSTED_URL: target._tag === "SelfHosted" ? target.url : "",
  CONVEX_SELF_HOSTED_ADMIN_KEY:
    target._tag === "SelfHosted" ? target.adminKey : "",
  CONVEX_OVERRIDE_ACCESS_TOKEN: "",
  CONVEX_PROVISION_HOST: "",
});

export class CommandError extends Schema.TaggedError<
  CommandError,
  { readonly brand: unique symbol }
>()("CommandError", {
  operation: Schema.Literals(["prepare", "deploy"]),
  reason: Schema.Literals(["configuration", "spawn", "exit"]),
  exitCode: Schema.optionalKey(Schema.Finite),
  signal: Schema.optionalKey(Schema.String),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    const status =
      this.signal === undefined
        ? this.exitCode === undefined
          ? this.reason
          : `exit code ${this.exitCode}`
        : `signal ${this.signal}`;
    return `${this.operation} command failed (${status})${this.stdout === undefined ? "" : `\nstdout:\n${this.stdout}`}${this.stderr === undefined ? "" : `\nstderr:\n${this.stderr}`}`;
  }
}

export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    readonly prepare: (
      command: PrepareCommand,
      deployment: DeploymentKind,
      cwd?: string,
    ) => Effect.Effect<void, CommandError>;
    readonly deploy: (
      target: PushTarget,
      cwd?: string,
    ) => Effect.Effect<void, CommandError>;
  }
>()("@confect/alchemy/internal/CommandRunner") {}

/**
 * The ambient variables a child process needs to run on every platform; the
 * rest of the parent environment, credentials included, is withheld.
 */
export const processEnvironment = Config.all({
  PATH: Config.String("PATH").pipe(
    Config.orElse(() => Config.String("Path")),
    Config.withDefault(""),
  ),
  HOME: Config.String("HOME").pipe(Config.withDefault("")),
  USERPROFILE: Config.String("USERPROFILE").pipe(Config.withDefault("")),
  SystemRoot: Config.String("SystemRoot").pipe(
    Config.orElse(() => Config.String("SYSTEMROOT")),
    Config.withDefault(""),
  ),
  TMPDIR: Config.String("TMPDIR").pipe(Config.withDefault("")),
  TEMP: Config.String("TEMP").pipe(Config.withDefault("")),
});

const packageBin = Effect.fn("CommandRunner.packageBin")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  packageName: string,
  binName: string,
) {
  const invalid = () =>
    CommandError.make({
      operation: packageName === "convex" ? "deploy" : "prepare",
      reason: "configuration",
    });
  let directory = cwd;
  while (true) {
    const manifestPath = path.join(
      directory,
      "node_modules",
      packageName,
      "package.json",
    );
    if (yield* fs.exists(manifestPath).pipe(Effect.mapError(invalid))) {
      const manifest = yield* fs.readFileString(manifestPath).pipe(
        Effect.flatMap(
          Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                bin: Schema.Union([
                  Schema.String,
                  Schema.Record(Schema.String, Schema.String),
                ]),
              }),
            ),
          ),
        ),
        Effect.mapError(invalid),
      );
      const relative =
        typeof manifest.bin === "string" ? manifest.bin : manifest.bin[binName];
      if (relative === undefined || relative === "") return yield* invalid();
      return path.resolve(path.dirname(manifestPath), relative);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return yield* invalid();
    directory = parent;
  }
});

const outputTailSize = 8192;

const outputTail = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  redact: (text: string) => string,
) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => ({ text: "", truncated: false }),
      (tail, chunk) => {
        const text = tail.text + chunk;
        return {
          text: Str.slice(-outputTailSize)(text),
          truncated: tail.truncated || text.length > outputTailSize,
        };
      },
    ),
    Effect.map(({ text, truncated }) => {
      text = stripVTControlCharacters(text);
      if (truncated) {
        // A clipped token may be an unrecognised deploy key. Drop it whole.
        text = Str.replace(/^\S*/, "")(text);
      }
      return Str.slice(-outputTailSize)(redact(text));
    }),
  );

/**
 * @internal
 */
export const layer = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const credentials = yield* Redaction.credentials;
    const run = Effect.fn("CommandRunner.run")(function* (
      operation: "prepare" | "deploy",
      command: string,
      args: ReadonlyArray<string>,
      cwd: string,
      env: Record<string, string | Redacted.Redacted<string> | undefined>,
    ) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd,
              env,
              extendEnv: false,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
          const exited = yield* Deferred.make<void>();
          // Descendants can inherit pipes and keep them open after the CLI exits.
          const drainDeadline = Deferred.await(exited).pipe(
            Effect.andThen(Effect.sleep("1 second")),
          );
          const [code, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode.pipe(
                Effect.result,
                Effect.tap(() => Deferred.succeed(exited, undefined)),
              ),
              outputTail(
                child.stdout.pipe(Stream.interruptWhen(drainDeadline)),
                credentials.redact,
              ),
              outputTail(
                child.stderr.pipe(Stream.interruptWhen(drainDeadline)),
                credentials.redact,
              ),
            ],
            { concurrency: "unbounded" },
          );
          if (Result.isFailure(code)) {
            // The spawner exposes a terminating signal only in its cause message.
            const cause = code.failure.cause;
            const signal =
              cause instanceof Error
                ? /^Process interrupted due to receipt of signal: '(SIG[A-Z0-9]+)'$/.exec(
                    cause.message,
                  )?.[1]
                : undefined;
            return yield* CommandError.make({
              operation,
              reason: "exit",
              ...(signal === undefined ? {} : { signal }),
              stdout,
              stderr,
            });
          }
          if (code.success !== 0)
            return yield* CommandError.make({
              operation,
              reason: "exit",
              exitCode: Number(code.success),
              stdout,
              stderr,
            });
        }),
      ).pipe(
        Effect.mapError((error) =>
          Schema.is(CommandError)(error)
            ? error
            : CommandError.make({ operation, reason: "spawn" }),
        ),
      );
    });
    const environment = processEnvironment.pipe(
      Effect.map((env) => ({ ...env, CI: "true", DO_NOT_TRACK: "1" })),
    );
    return CommandRunner.of({
      prepare: Effect.fn("CommandRunner.prepare")(function* (
        command,
        deployment,
        cwd = process.cwd(),
      ) {
        const directory = path.resolve(cwd);
        const env = yield* environment.pipe(
          Effect.mapBoth({
            onSuccess: (inherited) => ({
              ...inherited,
              CONFECT_DEPLOYMENT_KIND: deployment,
            }),
            onFailure: () =>
              CommandError.make({
                operation: "prepare",
                reason: "configuration",
              }),
          }),
        );
        if (command.command === "confect") {
          const bin = yield* packageBin(
            fs,
            path,
            directory,
            "@confect/cli",
            "confect",
          );
          yield* run(
            "prepare",
            process.execPath,
            [bin, ...command.args],
            directory,
            env,
          );
        } else {
          yield* run("prepare", command.command, command.args, directory, env);
        }
      }),
      deploy: Effect.fn("CommandRunner.deploy")(function* (
        target,
        cwd = process.cwd(),
      ) {
        const directory = path.resolve(cwd);
        const bin = yield* packageBin(fs, path, directory, "convex", "convex");
        const env = yield* environment.pipe(
          Effect.mapError(() =>
            CommandError.make({
              operation: "deploy",
              reason: "configuration",
            }),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            // An empty home keeps the user's Convex login and config out.
            const temp = yield* fs.makeTempDirectoryScoped({
              prefix: "confect-deploy-",
            });
            yield* credentials.add(
              target._tag === "Cloud" ? target.deployKey : target.adminKey,
            );
            yield* run(
              "deploy",
              process.execPath,
              [bin, "deploy", "--yes"],
              directory,
              {
                ...env,
                HOME: temp,
                USERPROFILE: temp,
                LOCALAPPDATA: temp,
                XDG_CONFIG_HOME: temp,
                ...selection(target),
              },
            );
          }).pipe(
            Effect.mapError((error) =>
              Schema.is(CommandError)(error)
                ? error
                : CommandError.make({
                    operation: "deploy",
                    reason: "configuration",
                  }),
            ),
          ),
        );
      }),
    });
  }),
);
