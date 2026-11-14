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
 * stay one copy too.
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
     * Absolute directories of packages' own source, which stay one copy as a
     * package under `node_modules` does.
     */
    readonly packages?: ReadonlyArray<string>;
  } = {},
): Plugin => {
  const packages = Arr.map(
    settings.packages ?? [],
    (directory) => `${pipe(directory, Str.replaceAll("\\", "/"))}/`,
  );
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
        shared(resolved.id)
      )
        return resolved;
      return {
        ...resolved,
        id: `${resolved.id}?${tag}=${encodeURIComponent(mount)}`,
      };
    },
    transform(code, id) {
      // Appended, so the module's existing source map still holds.
      return split(id).mount === undefined
        ? null
        : { code: `${code}\n;${installed}\n`, map: null };
    },
  };
};
