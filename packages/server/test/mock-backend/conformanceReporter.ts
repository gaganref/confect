import type { Reporter, TestModule } from "vitest/node";
import { exceptions } from "./conformance";

/**
 * The convex-test lane's check that each excepted case ran. A case that did
 * not, skipped or with its whole file skipped, proves nothing, and Vitest runs
 * no hook of a file whose cases are all skipped, so the check reads the run's
 * results. A file left out of the run, by a path filter, is not checked.
 */
export default class ConformanceReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const unrun = exceptions.filter((entry) => {
      const module = testModules.find((candidate) =>
        candidate.moduleId.replaceAll("\\", "/").endsWith(`/${entry.file}`),
      );
      if (module === undefined) return false;
      const state = Array.from(module.children.allTests())
        .find((test) => test.fullName === entry.name)
        ?.result().state;
      return state !== "passed" && state !== "failed";
    });
    if (unrun.length === 0) return;
    process.exitCode = 1;
    process.stderr.write(
      `conformance.ts excepts cases the convex-test lane did not run: ${unrun
        .map(({ file, name }) => `${file} ${JSON.stringify(name)}`)
        .join(", ")}. Run them, or remove their entries.\n`,
    );
  }
}
