import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

/**
 * The sources of modules a test defines inline, keyed as the modules are, for
 * the kernel to read each module's `"use node"` directive from: a file that
 * only exports, so it runs in Convex's isolate, with `"use node";` first for
 * each module `node` names.
 */
export const inlineSources = (
  modules: Record<string, unknown>,
  node: ReadonlyArray<string> = [],
): Record<string, () => Promise<string>> =>
  Rec.map(
    modules,
    (_, path) => () =>
      // An inline module stands for a file that exports, which Convex's
      // bundler registers.
      Promise.resolve(
        `${Arr.contains(node, path) ? '"use node";\n' : ""}export {};\n`,
      ),
  );

/**
 * `modules` with their sources, for a test that builds a kernel over modules it
 * defines inline: as {@link inlineSources}, with `files` taking the place of the
 * inline source for each module the test loads from a real file.
 */
export const withSources = <M extends Record<string, unknown>>(
  modules: M,
  files: Record<string, () => Promise<string>> = {},
) => ({ modules, sources: { ...inlineSources(modules), ...files } });
