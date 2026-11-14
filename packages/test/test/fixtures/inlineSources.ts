import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

/**
 * The sources of modules a test defines inline, keyed as the modules are, for
 * the kernel to read each module's `"use node"` directive from: an empty file
 * for each module, so it runs in Convex's isolate, and `"use node";` for each
 * module `node` names.
 */
export const inlineSources = (
  modules: Record<string, unknown>,
  node: ReadonlyArray<string> = [],
): Record<string, () => Promise<string>> =>
  Rec.map(
    modules,
    (_, path) => () =>
      Promise.resolve(Arr.contains(node, path) ? '"use node";\n' : ""),
  );

/**
 * `modules` with their sources, for a test that builds a kernel over modules it
 * defines inline: as {@link inlineSources}, with `files` taking the place of the
 * empty source for each module the test loads from a real file.
 */
export const withSources = <M extends Record<string, unknown>>(
  modules: M,
  files: Record<string, () => Promise<string>> = {},
) => ({ modules, sources: { ...inlineSources(modules), ...files } });
