// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vite builds its plugins synchronously, outside any Effect runtime.
import { statSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vite builds its plugins synchronously, outside any Effect runtime.
import * as path from "node:path";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { Plugin } from "vitest/config";
import * as PackageDirectory from "./internal/PackageDirectory.js";

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

/**
 * The modules that get a copy per mount: scripts, and JSON, whose object a
 * mount may mutate. An asset or WASM stays one copy, as its export is a URL, a
 * string or a loader.
 */
const copied = /\.(?:[cm]?[jt]sx?|json)$/;

/**
 * Vite's JSON plugin takes a module whose id ends in `.json`, so a tagged JSON
 * module names its language after the tag.
 */
const language = (file: string) =>
  pipe(file, Str.endsWith(".json")) ? "&lang.json" : "";

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
 * Give each mount of a component its own copy of every file its modules import,
 * wherever the file sits, as a deployment bundles everything a component
 * imports into each mount. Generated `testing.ts` loads a mount's modules with
 * the mount's path in their query, and the plugin carries that query down the
 * import graph, so a helper's module code runs once per mount, under that
 * mount's settings.
 *
 * A package under `node_modules` stays one copy for the whole test, as the
 * kernel itself runs on Effect, `convex` and this package. A deployment
 * evaluates a mount's packages apart too, so a package's module-level state is
 * per mount there and shared here. A workspace that aliases its packages to
 * their source names those source directories in `packages`, and their files
 * stay one copy too. Only scripts and JSON get a copy per mount: an asset, WASM
 * or a `?raw` or `?url` import stays one copy.
 *
 * ```ts
 * import { plugin } from "@confect/test/Vite";
 * import { defineConfig } from "vitest/config";
 *
 * export default defineConfig({ plugins: [plugin()] });
 * ```
 */
export const plugin = (
  settings: {
    /**
     * Directories of packages' own source, which stay one copy as a package
     * under `node_modules` does. Each is resolved, so a trailing separator
     * names the same directory, and one that is missing or not a directory
     * stops the plugin, naming it.
     */
    readonly packages?: ReadonlyArray<string>;
  } = {},
): Plugin => {
  const packages = Arr.map(settings.packages ?? [], (entry) => {
    if (statSync(entry, { throwIfNoEntry: false })?.isDirectory() !== true)
      throw new Error(
        `@confect/test/Vite: the packages entry ${entry} is not a directory.`,
      );
    const directory = PackageDirectory.normalize(entry, path);
    return pipe(directory, Str.endsWith("/")) ? directory : `${directory}/`;
  });
  const shared = (id: string) =>
    pipe(id, Str.includes("/node_modules/")) ||
    Arr.some(packages, (directory) => pipe(id, Str.startsWith(directory)));
  return {
    name: "@confect/test",
    enforce: "pre",
    // oxlint-disable-next-line effecttsgo/async-function -- Vite's resolveId hook is a Promise-returning callback.
    async resolveId(source, importer, options) {
      if (importer === undefined) return null;
      const { file, mount } = split(importer);
      if (mount === undefined) return null;
      const resolved = await this.resolve(source, file, {
        ...options,
        skipSelf: true,
      });
      if (
        resolved === null ||
        Boolean(resolved.external) ||
        pipe(resolved.id, Str.includes("?")) ||
        pipe(resolved.id, Str.startsWith("\0")) ||
        !copied.test(resolved.id) ||
        shared(resolved.id)
      )
        return resolved;
      return {
        ...resolved,
        id: `${resolved.id}?${tag}=${encodeURIComponent(mount)}${language(resolved.id)}`,
      };
    },
    transform: {
      // After Vite's own transforms, so a tagged JSON module is already a
      // script. Appended, so the module's existing source map still holds.
      order: "post",
      handler: (code, id) =>
        split(id).mount === undefined
          ? null
          : { code: `${code}\n;${installed}\n`, map: null },
    },
  };
};
