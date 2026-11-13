// oxlint-disable-next-line effecttsgo/node-builtin-import -- A Vitest setup file checks the entries before any Effect runtime exists.
import fs from "node:fs";
import { createRequire } from "node:module";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A Vitest setup file checks the entries before any Effect runtime exists.
import path from "node:path";
import type { RunnerTestFile, RunnerTestSuite } from "vitest";
import { afterEach, beforeAll, beforeEach } from "vitest";
import { exceptions, refusals } from "./conformance";

// The convex-test lane (`vitest.mock-backend.config.ts`) runs each case in
// `conformance.ts` and requires it to fail on convex-test with the binary
// behaviour its entry observes. An entry that does not name one case exactly,
// or was checked against another convex-test version, fails the lane.

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

const allCases = (suite: RunnerTestSuite | RunnerTestFile): Array<string> =>
  suite.tasks.flatMap((task) =>
    task.type === "suite" ? allCases(task) : [fullName(task)],
  );

const fileName = (file: RunnerTestFile) =>
  file.filepath.replaceAll("\\", "/").split("/").pop()!;

const installed = (
  createRequire(import.meta.url)("convex-test/package.json") as {
    readonly version: string;
  }
).version;

const missing = exceptions.filter(
  ({ file }) => !fs.existsSync(path.join(import.meta.dirname, file)),
);
if (missing.length > 0) {
  throw new Error(
    `conformance.ts names files the mock-backend suite does not have: ${missing.map(({ file }) => file).join(", ")}`,
  );
}

const entryFor = (task: Task) => {
  const name = fullName(task);
  return exceptions.find(
    (exception) =>
      exception.file === fileName(task.file) && exception.name === name,
  );
};

// Vitest 5 passes the suite second and reads fixtures from the first argument's
// destructuring pattern.
// oxlint-disable-next-line no-empty-pattern
beforeAll(({}, suite) => {
  const file = suite as RunnerTestFile;
  const cases = allCases(file);
  const refused = exceptions
    .filter((entry) => entry.file === fileName(file))
    .flatMap((entry) => refusals(entry, cases, installed));
  if (refused.length > 0) {
    throw new Error(
      `conformance.ts has entries the convex-test lane refuses:\n${refused.join("\n")}`,
    );
  }
});

// An excepted case must fail. Vitest reports one that passes as "Expect test
// to fail", which fails the lane.
beforeEach(({ task }) => {
  if (entryFor(task) !== undefined) task.fails = true;
});

// A case that fails for another reason than the binary behaviour its entry
// records keeps its own failure.
afterEach(({ task }) => {
  const entry = entryFor(task);
  if (entry === undefined || task.result?.state !== "fail") return;
  if (!JSON.stringify(task.result.errors ?? []).includes(entry.observed)) {
    task.fails = false;
  }
});
