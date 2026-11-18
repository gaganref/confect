import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as MountSteps from "../src/MountSteps";

/**
 * A backend whose deploy module mounts `child`, which mounts `grandchild`,
 * recording each call the traversal makes.
 */
const backend = () => {
  const calls: Array<string> = [];
  const steps: Readonly<Record<string, ReadonlyArray<unknown>>> = {
    "": [
      {
        componentPath: "child",
        nested: true,
        init: { functionName: "init:run", args: {} },
      },
    ],
    child: [
      {
        componentPath: "grandchild",
        nested: false,
        init: { functionName: "init:run", args: {} },
      },
    ],
  };
  const runner: MountSteps.Runner<string, never> = {
    steps: (prefix) =>
      Effect.sync(() => {
        calls.push(`steps ${prefix ?? ""}`);
        return steps[prefix ?? ""] ?? [];
      }),
    init: (mount, functionName) =>
      Effect.sync(() => {
        calls.push(`init ${mount === "" ? "(root)" : mount} ${functionName}`);
      }),
    failed: (mount, detail) => `${mount}: ${detail}`,
  };
  return { calls, runner };
};

describe("MountSteps.run", () => {
  it.effect(
    "walks an app's steps, each mount's init before its nested steps",
    () =>
      Effect.gen(function* () {
        const { calls, runner } = backend();
        yield* MountSteps.run(runner);
        expect(calls).toEqual([
          "steps ",
          "init child init:run",
          "steps child",
          "init child/grandchild init:run",
        ]);
      }),
  );

  it.effect(
    "runs a root step's own init first, then its steps, as a parent's push runs a mounted backend",
    () =>
      Effect.gen(function* () {
        const { calls, runner } = backend();
        yield* MountSteps.run(runner, {
          init: { functionName: "install:init", args: {} },
          nested: true,
        });
        expect(calls).toEqual([
          "init (root) install:init",
          "steps ",
          "init child init:run",
          "steps child",
          "init child/grandchild init:run",
        ]);
      }),
  );

  it.effect("runs only the root's init when it has no steps", () =>
    Effect.gen(function* () {
      const { calls, runner } = backend();
      yield* MountSteps.run(runner, {
        init: { functionName: "install:init", args: {} },
        nested: false,
      });
      expect(calls).toEqual(["init (root) install:init"]);
    }),
  );
});
