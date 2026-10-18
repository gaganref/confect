import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import {
  checkMerge,
  inspectRelease,
  planMerge,
  selectReleaseTag,
} from "./mergeUpstreamRelease";

test("selects the newest stable core release numerically", () => {
  expect(
    Result.getOrThrow(
      selectReleaseTag([
        "@confect/core@10.2.0",
        "@confect/server@99.0.0",
        "@confect/core@11.0.0-next.9",
        "@confect/core@10.10.0",
        "@confect/core@10.9.99",
        "@confect/core@010.20.0",
      ]),
    ),
  ).toBe("@confect/core@10.10.0");
});

test("reports when no stable core release is available", () => {
  const result = selectReleaseTag(["@confect/core@10.0.0-next.9", "v10.2.0"]);
  expect(Result.isFailure(result) && result.failure._tag).toBe(
    "NoStableCoreRelease",
  );
});

test("merges only a release the fork does not already contain", () => {
  expect(
    planMerge({
      tag: "@confect/core@10.2.0",
      target: "release",
      base: "release",
      forkHead: "fork-patch",
    }),
  ).toEqual({
    _tag: "AlreadyMerged",
    tag: "@confect/core@10.2.0",
    target: "release",
    base: "release",
    forkHead: "fork-patch",
  });
  expect(
    planMerge({
      tag: "@confect/core@10.3.0",
      target: "new-release",
      base: "old-release",
      forkHead: "fork-patch",
    }),
  ).toEqual({
    _tag: "Merge",
    tag: "@confect/core@10.3.0",
    target: "new-release",
    base: "old-release",
    forkHead: "fork-patch",
  });
});

const makeHistory = (conflict = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-merge-history-",
    });
    const root = yield* fs.realPath(temporary);
    const git = (args: Array<string>) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    git(["init", "--initial-branch=upstream"]);
    git(["config", "user.name", "Confect test"]);
    git(["config", "user.email", "confect@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    yield* fs.writeFileString(`${root}/shared.txt`, "base\n");
    git(["add", "."]);
    git(["commit", "-m", "Release base"]);
    const base = git(["rev-parse", "HEAD"]);
    git(["tag", "@confect/core@10.2.0"]);
    git(["switch", "-c", "fork"]);
    yield* fs.writeFileString(
      `${root}/${conflict ? "shared.txt" : "fork.txt"}`,
      "fork\n",
    );
    git(["add", "."]);
    git(["commit", "-m", "Fork patch"]);
    const forkHead = git(["rev-parse", "HEAD"]);
    git(["switch", "upstream"]);
    yield* fs.writeFileString(`${root}/shared.txt`, "upstream\n");
    git(["add", "."]);
    git(["commit", "-m", "New release"]);
    const target = git(["rev-parse", "HEAD"]);
    git(["tag", "@confect/core@10.3.0"]);
    return { root, git, base, target, forkHead };
  });

const worktrees = (git: (args: Array<string>) => string) =>
  git(["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));

test("computes the merge base with the release from git history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { root, base, target, forkHead } = yield* makeHistory();
      expect(yield* inspectRelease(root, "fork")).toEqual({
        _tag: "Merge",
        tag: "@confect/core@10.3.0",
        base,
        target,
        forkHead,
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test.each([false, true])(
  "dry-runs a real scratch merge and preserves the fork, conflict=%s",
  (conflict) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, git, target, forkHead } = yield* makeHistory(conflict);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${root}/shared.txt`, "uncommitted work\n");
        yield* fs.writeFileString(`${root}/untracked.txt`, "untracked work\n");
        const result = yield* checkMerge(root, "fork").pipe(Effect.result);
        if (conflict) {
          expect(Result.isFailure(result) && result.failure).toMatchObject({
            _tag: "MergeConflict",
            tag: "@confect/core@10.3.0",
            files: ["shared.txt"],
          });
        } else {
          expect(result._tag).toBe("Success");
        }
        expect(git(["rev-parse", "fork"])).toBe(forkHead);
        expect(git(["rev-parse", "HEAD"])).toBe(target);
        expect(yield* fs.readFileString(`${root}/shared.txt`)).toBe(
          "uncommitted work\n",
        );
        expect(yield* fs.readFileString(`${root}/untracked.txt`)).toBe(
          "untracked work\n",
        );
        expect(git(["status", "--porcelain"])).toBe(
          "M shared.txt\n?? untracked.txt",
        );
        expect(
          git(["branch", "--list"])
            .split("\n")
            .map((b) => b.trim()),
        ).toEqual(["fork", "* upstream"]);
        expect(worktrees(git)).toEqual([`worktree ${root}`]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    ),
);

test("treats a release merged into the fork as current, with fork patches after it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { root, git } = yield* makeHistory();
      git(["switch", "fork"]);
      git(["merge", "--no-edit", "@confect/core@10.3.0"]);
      git(["commit", "--allow-empty", "-m", "Fork patch after the merge"]);
      const forkHead = git(["rev-parse", "fork"]);
      git(["switch", "upstream"]);
      expect(yield* checkMerge(root, "fork")).toMatchObject({
        _tag: "AlreadyMerged",
        tag: "@confect/core@10.3.0",
      });
      expect(git(["rev-parse", "fork"])).toBe(forkHead);
      expect(worktrees(git)).toEqual([`worktree ${root}`]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("treats the newest tag as current when the fork merged untagged upstream commits past it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { root, git, target } = yield* makeHistory();
      git(["tag", "-d", "@confect/core@10.3.0"]);
      git(["switch", "fork"]);
      git(["merge", "--no-edit", target]);
      git(["switch", "upstream"]);
      expect(yield* inspectRelease(root, "fork")).toMatchObject({
        _tag: "AlreadyMerged",
        tag: "@confect/core@10.2.0",
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("merges the stable tag while upstream main has a conflicting later commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, git, forkHead } = yield* makeHistory();
      yield* fs.writeFileString(
        `${root}/fork.txt`,
        "upstream main after the release\n",
      );
      git(["add", "."]);
      git(["commit", "-m", "Unreleased conflicting change"]);
      const upstreamHead = git(["rev-parse", "upstream"]);
      expect(yield* checkMerge(root, "fork")).toMatchObject({
        _tag: "Merge",
        tag: "@confect/core@10.3.0",
      });
      expect(git(["rev-parse", "fork"])).toBe(forkHead);
      expect(git(["rev-parse", "upstream"])).toBe(upstreamHead);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));
