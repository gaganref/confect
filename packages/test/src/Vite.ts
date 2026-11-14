// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vite calls the resolver synchronously per import, outside any Effect runtime.
import { existsSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vite calls the resolver synchronously per import, outside any Effect runtime.
import * as path from "node:path";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { Plugin } from "vitest/config";

/**
 * The query generated `testing.ts` adds to each module it loads for a mount,
 * naming that mount.
 */
const tag = "confect-mount";

/**
 * Each module loaded as one mount's copy sets this, so generated `testing.ts`
 * can tell the plugin is installed.
 */
const installed = 'globalThis[Symbol.for("@confect/test/Vite")] = true;';

const configFiles = [
  "convex.config.ts",
  "convex.config.js",
  "convex.config.mts",
  "convex.config.mjs",
];

const split = (id: string) =>
  Option.match(pipe(id, Str.indexOf("?")), {
    onNone: () => ({ file: id, mount: undefined }),
    onSome: (at) => ({
      file: pipe(id, Str.slice(0, at)),
      mount:
        new URLSearchParams(pipe(id, Str.slice(at + 1))).get(tag) ?? undefined,
    }),
  });

/**
 * The directory a component's `convex.config` sits in has the component's own
 * files beside it, as Confect lays a component out: its parent holds them all.
 */
const componentRoot = (directory: string): string | undefined => {
  if (Arr.some(configFiles, (name) => existsSync(path.join(directory, name))))
    return path.dirname(directory);
  const parent = path.dirname(directory);
  return parent === directory ? undefined : componentRoot(parent);
};

const inside = (file: string, root: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    !pipe(relative, Str.startsWith("..")) &&
    !path.isAbsolute(relative) &&
    !Arr.contains(pipe(relative, Str.split(path.sep)), "node_modules")
  );
};

/**
 * Give each mount of a component its own copy of every file inside the
 * component that its modules import, as a deployment evaluates each mount's
 * modules apart. Generated `testing.ts` loads a mount's modules with the
 * mount's name in their query; the plugin carries that query to the component's
 * own files they import, so a helper's module code runs once per mount, under
 * that mount's settings. Packages under `node_modules` stay one copy for the
 * whole test.
 *
 * ```ts
 * import { plugin } from "@confect/test/Vite";
 * import { defineConfig } from "vitest/config";
 *
 * export default defineConfig({ plugins: [plugin()] });
 * ```
 */
export const plugin = (): Plugin => {
  // The component each tagged module belongs to, by its id.
  const roots = new Map<string, string>();
  return {
    name: "@confect/test",
    enforce: "pre",
    // oxlint-disable-next-line effecttsgo/async-function -- Vite's resolveId hook is a Promise-returning callback.
    async resolveId(source, importer, options) {
      if (importer === undefined) return null;
      const { file, mount } = split(importer);
      if (mount === undefined) return null;
      const root = roots.get(importer) ?? componentRoot(path.dirname(file));
      if (root === undefined) return null;
      const resolved = await this.resolve(source, file, {
        ...options,
        skipSelf: true,
      });
      if (
        resolved === null ||
        Boolean(resolved.external) ||
        pipe(resolved.id, Str.includes("?")) ||
        pipe(resolved.id, Str.startsWith("\0")) ||
        !inside(resolved.id, root)
      )
        return resolved;
      const id = `${resolved.id}?${tag}=${encodeURIComponent(mount)}`;
      roots.set(id, root);
      return { ...resolved, id };
    },
    transform(code, id) {
      // Appended, so the module's existing source map still holds.
      return split(id).mount === undefined
        ? null
        : { code: `${code}\n;${installed}\n`, map: null };
    },
  };
};
