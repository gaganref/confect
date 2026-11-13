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
  Object.fromEntries(
    Object.keys(modules).map((path) => [
      path,
      () => Promise.resolve(node.includes(path) ? '"use node";\n' : ""),
    ]),
  );
