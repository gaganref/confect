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
