import type { RunnerTestFile, RunnerTestSuite } from "vitest";
import { afterEach, beforeAll, beforeEach } from "vitest";
// Imported by relative path, as in `TestConfect.ts`.
import { ownsConvexGlobal } from "../../../test/src/internal/Execution";
import { placements } from "./kernelPlacement";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Json from "../../../test/src/internal/Json";

type Task = RunnerTestSuite["tasks"][number];

const fullName = (task: Task): string => {
  const names: Array<string> = [];
  for (
    let current: Task | undefined = task;
    current !== undefined &&
    current.type !== undefined &&
    current !== task.file;
    current = current.suite
  ) {
    names.unshift(current.name);
  }
  return Arr.join(names, " > ");
};

const covers = (name: string | undefined, caseName: string) =>
  name === undefined ||
  caseName === name ||
  pipe(caseName, String.startsWith(`${name} > `));

const fileName = (file: RunnerTestFile) =>
  pipe(file.filepath, String.replaceAll("\\", "/"), String.split("/")).pop()!;

const forFile = (file: RunnerTestFile) =>
  Arr.filter(placements, (placement) => placement.file === fileName(file));

const allCases = (suite: RunnerTestSuite | RunnerTestFile): Array<string> =>
  Arr.flatMap(suite.tasks, (task) =>
    task.type === "suite" ? allCases(task) : [fullName(task)],
  );

// Vitest 5 passes the suite second and reads fixtures from the first argument's
// destructuring pattern.
// oxlint-disable-next-line no-empty-pattern
beforeAll(({}, suite) => {
  const file = suite as RunnerTestFile;
  const names = allCases(file);
  const stale = Arr.filter(
    forFile(file),
    (placement) => !Arr.some(names, (name) => covers(placement.name, name)),
  );
  if (stale.length > 0) {
    throw new Error(
      `kernelPlacement.ts places cases ${fileName(file)} no longer has: ${pipe(
        stale,
        Arr.map((placement) => Json.stringify(placement.name)),
        Arr.join(", "),
      )}`,
    );
  }
});

beforeEach((context) => {
  const name = fullName(context.task);
  const placement = Option.getOrUndefined(
    Arr.findFirst(forFile(context.task.file), (entry) =>
      covers(entry.name, name),
    ),
  );
  if (placement !== undefined) {
    context.skip(`kernel row ${placement.row}: ${placement.needs}`);
  }
});

afterEach(() => {
  if (
    (globalThis as { Convex?: unknown }).Convex !== undefined &&
    !ownsConvexGlobal()
  ) {
    throw new Error(
      "A backend other than the test kernel installed globalThis.Convex in the kernel lane.",
    );
  }
});
