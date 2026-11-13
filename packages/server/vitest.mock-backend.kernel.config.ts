// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vitest config needs synchronous file resolution before an Effect runtime exists.
import fs from "node:fs";
import { createRequire } from "node:module";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vitest config needs synchronous path resolution before an Effect runtime exists.
import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig, mergeConfig, type Plugin } from "vitest/config";
import sharedConfig from "../../vitest.shared";
import * as String from "effect/String";
import { pipe } from "effect/Function";

const shim = path.resolve(
  import.meta.dirname,
  "../test/src/internal/ConvexTest.ts",
);

// The installed convex-test package. Nothing in the kernel lane may load it.
const convexTestRoot = fs.realpathSync(
  path.dirname(
    path.dirname(createRequire(import.meta.url).resolve("convex-test")),
  ),
);

const withinConvexTest = (id: string) => {
  const file = pipe(id, String.split("?"))[0];
  if (!path.isAbsolute(file) || !fs.existsSync(file)) return false;
  const relative = path.relative(convexTestRoot, fs.realpathSync(file));
  return !pipe(relative, String.startsWith("..")) && !path.isAbsolute(relative);
};

const refuseConvexTest: Plugin = {
  name: "confect:refuse-convex-test",
  enforce: "pre",
  resolveId(source, importer, options) {
    return this.resolve(source, importer, { ...options, skipSelf: true }).then(
      (resolved) => {
        if (resolved !== null && withinConvexTest(resolved.id)) {
          throw new Error(
            // oxlint-disable-next-line effecttsgo/global-json -- Vitest config quotes a specifier in a sync resolver error before an Effect runtime exists.
            `The kernel lane refuses convex-test: ${JSON.stringify(source)} from ${importer ?? "the test runner"} resolved to ${resolved.id}.`,
          );
        }
        return resolved;
      },
    );
  },
};

// Lane 1: the mock-backend suite on the test kernel. `convex-test` resolves to
// the kernel's shim, the real package is refused, and the cases the inventory
// places in later rows are skipped by `kernelLane.ts`.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [tsconfigPaths(), refuseConvexTest],
    resolve: {
      alias: [
        { find: /^convex-test$/, replacement: shim },
        {
          find: /^@confect\/server$/,
          replacement: path.resolve(import.meta.dirname, "./src/index.ts"),
        },
        {
          find: /^@confect\/server\/(.*)$/,
          replacement: path.resolve(import.meta.dirname, "./src/$1"),
        },
      ],
    },
    test: {
      root: import.meta.dirname,
      name: "@confect/server (mock-backend, kernel)",
      include: ["test/mock-backend/**/*.test.ts"],
      globalSetup: ["./test/mock-backend/setup.ts"],
      // `@confect/test/setup` first, so the kernel's host API guards are in
      // place before any test module loads.
      setupFiles: ["../test/src/setup.ts", "./test/mock-backend/kernelLane.ts"],
      typecheck: { enabled: false },
      coverage: { enabled: false },
    },
  }),
);
