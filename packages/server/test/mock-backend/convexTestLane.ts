// oxlint-disable-next-line effecttsgo/node-builtin-import -- A Vitest setup file checks the entries before any Effect runtime exists.
import fs from "node:fs";
import { createRequire } from "node:module";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A Vitest setup file checks the entries before any Effect runtime exists.
import path from "node:path";
import type { RunnerTestFile, RunnerTestSuite } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { beforeAll, beforeEach } from "vitest";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  exceptions,
  recordedDeparture,
  recordedOutcomes,
  refusals,
} from "./conformance";

// The convex-test lane (`vitest.mock-backend.config.ts`) runs each case in
// `conformance.ts` and requires it to fail on convex-test with the outcomes its
// entry records and no error but its own departure assertion. An entry
// that does not name one case exactly, or was checked against another
// convex-test version, fails the lane, and `conformanceReporter.ts` fails a run in which an
// excepted case did not run.

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

const allCases = (suite: RunnerTestSuite | RunnerTestFile): Array<string> =>
  Arr.flatMap(suite.tasks, (task) =>
    task.type === "suite" ? allCases(task) : [fullName(task)],
  );

const fileName = (file: RunnerTestFile) =>
  pipe(
    file.filepath,
    Str.replaceAll("\\", "/"),
    Str.split("/"),
    Arr.lastNonEmpty,
  );

const installed = (
  createRequire(import.meta.url)("convex-test/package.json") as {
    readonly version: string;
  }
).version;

const missing = Arr.filter(
  exceptions,
  ({ file }) => !fs.existsSync(path.join(import.meta.dirname, file)),
);
if (missing.length > 0) {
  throw new Error(
    `conformance.ts names files the mock-backend suite does not have: ${Arr.join(
      Arr.map(missing, ({ file }) => file),
      ", ",
    )}`,
  );
}

const entryFor = (task: Task) => {
  const name = fullName(task);
  return Option.getOrUndefined(
    Arr.findFirst(
      exceptions,
      (exception) =>
        exception.file === fileName(task.file) && exception.name === name,
    ),
  );
};

// Vitest 5 passes the suite second and reads fixtures from the first argument's
// destructuring pattern.
// oxlint-disable-next-line no-empty-pattern
beforeAll(({}, suite) => {
  const file = suite as RunnerTestFile;
  const cases = allCases(file);
  const refused = pipe(
    exceptions,
    Arr.filter((entry) => entry.file === fileName(file)),
    Arr.flatMap((entry) => refusals(entry, cases, installed)),
  );
  if (refused.length > 0) {
    throw new Error(
      `conformance.ts has entries the convex-test lane refuses:\n${Arr.join(refused, "\n")}`,
    );
  }
});

/**
 * Vitest's `test.fails`, which its runner reads after the case and its hooks
 * have run. The type marks it read-only because `it.fails` sets it at
 * collection.
 */
const expectFailure = (task: Task, fails: boolean) => {
  (task as { fails?: boolean }).fails = fails;
};

// An excepted case must fail. Vitest reports one that passes as "Expect test
// to fail", which fails the lane.
//
// A case that fails for any other reason keeps its own failure. It must fail
// with exactly one error, its departure assertion, raised through `departs` in
// its own body with the message its entry pins, and record exactly the
// outcomes its entry expects. A failing hook adds an error of its own, and an
// unrelated throw in a function it calls changes the outcomes. The check runs
// once the case's hooks have run, as `onTestFinished` does: an `afterEach`
// that throws stops the hooks after it, so one here could be skipped.
beforeEach(({ task, onTestFinished }) => {
  const entry = entryFor(task);
  if (entry === undefined) return;
  expectFailure(task, true);
  onTestFinished(() => {
    if (task.result?.state !== "fail") return;
    const errors = task.result.errors ?? [];
    const departure = recordedDeparture(task);
    const ownDeparture =
      errors.length === 1 &&
      departure !== undefined &&
      departure.file === entry.file &&
      departure.message === entry.departure &&
      errors[0]?.message === entry.departure;
    if (
      !ownDeparture ||
      !isDeepStrictEqual(recordedOutcomes(task), entry.outcomes)
    ) {
      expectFailure(task, false);
    }
  });
});
