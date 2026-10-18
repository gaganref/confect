import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class NoStableCoreRelease extends Schema.TaggedError<NoStableCoreRelease>()(
  "NoStableCoreRelease",
  { tags: Schema.Array(Schema.String) },
) {}

export const selectReleaseTag = (
  tags: ReadonlyArray<string>,
): Result.Result<string, NoStableCoreRelease> => {
  const releases = tags
    .filter((tag) =>
      /^@confect\/core@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
        tag,
      ),
    )
    .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
  return releases[0] === undefined
    ? Result.fail(new NoStableCoreRelease({ tags }))
    : Result.succeed(releases[0]);
};

interface ReleaseHistory {
  readonly tag: string;
  readonly target: string;
  readonly base: string;
  readonly forkHead: string;
}

export const planMerge = (
  history: ReleaseHistory,
): ReleaseHistory & { readonly _tag: "AlreadyMerged" | "Merge" } => ({
  ...history,
  _tag: history.base === history.target ? "AlreadyMerged" : "Merge",
});

class GitCommandFailed extends Schema.TaggedError<GitCommandFailed>()(
  "GitCommandFailed",
  {
    args: Schema.Array(Schema.String),
    directory: Schema.String,
    exitCode: Schema.Finite,
    output: Schema.String,
  },
) {}

class MergeFailed extends Schema.TaggedError<MergeFailed>()("MergeFailed", {
  tag: Schema.String,
  base: Schema.String,
  output: Schema.String,
}) {}

class MergeConflict extends Schema.TaggedError<MergeConflict>()(
  "MergeConflict",
  {
    tag: Schema.String,
    base: Schema.String,
    files: Schema.Array(Schema.String),
    output: Schema.String,
  },
) {}

const gitResult = Effect.fn("MergeRelease.commandResult")(function* (
  args: Array<string>,
  directory: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("git", args, {
      cwd: directory,
      stdin: "ignore",
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
      },
      extendEnv: true,
    }),
  );
  return yield* Effect.all(
    {
      exitCode: handle.exitCode,
      stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    },
    { concurrency: "unbounded" },
  );
}, Effect.scoped);

const git = Effect.fn("MergeRelease.git")(function* (
  args: Array<string>,
  directory: string,
) {
  const result = yield* gitResult(args, directory);
  if (result.exitCode !== 0)
    return yield* new GitCommandFailed({
      args,
      directory,
      exitCode: result.exitCode,
      output: result.stdout + result.stderr,
    });
  return result.stdout.trim();
});

export const inspectRelease = Effect.fn("MergeRelease.inspect")(function* (
  directory: string,
  forkRef: string,
) {
  const tags = (yield* git(
    ["tag", "--list", "@confect/core@*"],
    directory,
  )).split("\n");
  const tag = yield* Effect.fromResult(selectReleaseTag(tags));
  const forkHead = yield* git(["rev-parse", `${forkRef}^{commit}`], directory);
  const target = yield* git(["rev-parse", `${tag}^{commit}`], directory);
  const base = yield* git(["merge-base", forkHead, target], directory);
  return planMerge({ tag, target, base, forkHead });
});

export const checkMerge = Effect.fn("MergeRelease.check")(function* (
  directory: string,
  forkRef: string,
) {
  const plan = yield* inspectRelease(directory, forkRef);
  if (plan._tag === "AlreadyMerged") {
    yield* Console.log(
      `${forkRef} already contains ${plan.tag} (${plan.target})`,
    );
    return plan;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* fs.makeTempDirectoryScoped({
    prefix: "confect-merge-",
  });
  const scratch = path.join(temporary, "checkout");
  yield* Effect.acquireRelease(
    git(["worktree", "add", "--detach", scratch, plan.forkHead], directory),
    () =>
      Effect.gen(function* () {
        yield* git(["merge", "--abort"], scratch).pipe(Effect.ignore);
        yield* git(["worktree", "remove", "--force", scratch], directory);
      }).pipe(Effect.orDie),
  );
  const result = yield* gitResult(
    [
      "-c",
      "user.name=Confect merge check",
      "-c",
      "user.email=confect@example.invalid",
      "merge",
      "--no-commit",
      "--no-ff",
      plan.tag,
    ],
    scratch,
  );
  if (result.exitCode !== 0) {
    const files = (yield* git(
      ["diff", "--name-only", "--diff-filter=U"],
      scratch,
    ))
      .split("\n")
      .filter(Boolean);
    yield* Console.error(
      `Merging ${plan.tag} into ${forkRef} failed. Conflicting files:\n${files.join("\n") || "(none; see git output)"}`,
    );
    if (files.length === 0)
      return yield* new MergeFailed({
        tag: plan.tag,
        base: plan.base,
        output: result.stdout + result.stderr,
      });
    return yield* new MergeConflict({
      tag: plan.tag,
      base: plan.base,
      files,
      output: result.stdout + result.stderr,
    });
  }
  yield* Console.log(
    `${plan.tag} merges cleanly into ${forkRef}; fork ref remains ${plan.forkHead}`,
  );
  return plan;
}, Effect.scoped);

if (import.meta.main) {
  const [forkRef = "origin/main"] = Bun.argv.slice(2);
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* checkMerge(path.resolve(import.meta.dir, ".."), forkRef);
  }).pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain({ disableErrorReporting: true }),
  );
}
