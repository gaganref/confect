import type { Reporter, TestModule } from "vitest/node";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { exceptions } from "./conformance";

/**
 * The convex-test lane's check that each excepted case ran. A case that did
 * not, skipped or with its whole file skipped, proves nothing, and Vitest runs
 * no hook of a file whose cases are all skipped, so the check reads the run's
 * results. A file left out of the run, by a path filter, is not checked.
 */
export default class ConformanceReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const unrun = Arr.filter(exceptions, (entry) =>
      pipe(
        Arr.findFirst(testModules, (candidate) =>
          pipe(
            candidate.moduleId,
            Str.replaceAll("\\", "/"),
            Str.endsWith(`/${entry.file}`),
          ),
        ),
        Option.exists((module) => {
          const state = pipe(
            Arr.findFirst(
              Arr.fromIterable(module.children.allTests()),
              (test) => test.fullName === entry.name,
            ),
            Option.map((test) => test.result().state),
            Option.getOrUndefined,
          );
          return state !== "passed" && state !== "failed";
        }),
      ),
    );
    if (unrun.length === 0) return;
    process.exitCode = 1;
    process.stderr.write(
      `conformance.ts excepts cases the convex-test lane did not run: ${Arr.join(
        Arr.map(unrun, ({ file, name }) => `${file} "${name}"`),
        ", ",
      )}. Run them, or remove their entries.\n`,
    );
  }
}
