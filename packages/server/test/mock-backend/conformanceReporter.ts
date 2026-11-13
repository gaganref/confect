import type { Reporter, TestModule, Vitest } from "vitest/node";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { exceptions } from "./conformance";

/**
 * The convex-test lane's check that each excepted case ran. A case that did
 * not, skipped or with its whole file skipped, proves nothing, and Vitest runs
 * no hook of a file whose cases are all skipped, so the check reads the run's
 * results. A file left out of the run by a path filter is not checked, but one
 * the lane's config excludes fails the run, since it never runs there.
 */
export default class ConformanceReporter implements Reporter {
  private excludes: ReadonlyArray<string> = [];

  onInit(vitest: Vitest) {
    this.excludes = vitest.config.exclude;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const excluded = Arr.filter(exceptions, (entry) =>
      Arr.some(this.excludes, (pattern) =>
        pipe(
          pattern,
          Str.replaceAll("\\", "/"),
          (path) =>
            path === entry.file || pipe(path, Str.endsWith(`/${entry.file}`)),
        ),
      ),
    );
    if (excluded.length > 0) {
      process.exitCode = 1;
      process.stderr.write(
        `conformance.ts excepts cases in files the convex-test lane's config excludes: ${Arr.join(
          Arr.map(excluded, ({ file }) => file),
          ", ",
        )}. An excepted case must run there. Remove the exclusion.\n`,
      );
    }
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
