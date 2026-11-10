import type { RunnerTestFile, RunnerTestSuite } from "vitest";
import { afterEach, beforeAll, beforeEach } from "vitest";
// Imported by relative path, as in `TestConfect.ts`.
import { ownsConvexGlobal } from "../../../test/src/internal/Execution";
import { placements } from "./kernelPlacement";

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
  return names.join(" > ");
};

const covers = (name: string | undefined, caseName: string) =>
  name === undefined || caseName === name || caseName.startsWith(`${name} > `);

const fileName = (file: RunnerTestFile) =>
  file.filepath.replaceAll("\\", "/").split("/").pop()!;

const forFile = (file: RunnerTestFile) =>
  placements.filter((placement) => placement.file === fileName(file));

const allCases = (suite: RunnerTestSuite | RunnerTestFile): Array<string> =>
  suite.tasks.flatMap((task) =>
    task.type === "suite" ? allCases(task) : [fullName(task)],
  );

// Vitest 5 passes the suite second and reads fixtures from the first argument's
// destructuring pattern.
// oxlint-disable-next-line no-empty-pattern
beforeAll(({}, suite) => {
  const file = suite as RunnerTestFile;
  const names = allCases(file);
  const stale = forFile(file).filter(
    (placement) => !names.some((name) => covers(placement.name, name)),
  );
  if (stale.length > 0) {
    throw new Error(
      `kernelPlacement.ts places cases ${fileName(file)} no longer has: ${stale
        .map((placement) => JSON.stringify(placement.name))
        .join(", ")}`,
    );
  }
});

beforeEach((context) => {
  const name = fullName(context.task);
  const placement = forFile(context.task.file).find((entry) =>
    covers(entry.name, name),
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
