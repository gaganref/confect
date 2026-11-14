import type { Reporter, TestModule } from "vitest/node";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A Vitest reporter resolves module paths before any Effect runtime exists.
import path from "node:path";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import { exceptions, unrunExceptions, type CollectedCase } from "./conformance";

/**
 * The convex-test lane's check that each excepted case ran, read from Vitest's
 * own results. A case that did not run proves nothing, whatever kept it out: a
 * path filter, a glob or literal exclusion in the lane's config, a renamed
 * case, a skip, or a file whose cases are all skipped, which runs no hook. So
 * each entry must name a case the run collected, by its exact file under the
 * mock-backend suite and its full name, that passed or failed, or the run
 * fails.
 */
export default class ConformanceReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const collected = Arr.flatMap(
      testModules,
      (module): Array<CollectedCase> => {
        const file = pipe(
          path.relative(import.meta.dirname, module.moduleId),
          Str.replaceAll("\\", "/"),
        );
        return Arr.map(
          Arr.fromIterable(module.children.allTests()),
          (test) => ({
            file,
            name: test.fullName,
            state: test.result().state,
          }),
        );
      },
    );
    const unrun = unrunExceptions(exceptions, collected);
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
