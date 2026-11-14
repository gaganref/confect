// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vitest config needs synchronous path resolution before an Effect runtime exists.
import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [tsconfigPaths()],
    resolve: {
      alias: [
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
      name: "@confect/server (mock-backend)",
      include: ["test/mock-backend/**/*.test.ts"],
      // The kernel lane's own controls run only there.
      exclude: ["test/mock-backend/kernelLane.test.ts"],
      globalSetup: ["./test/mock-backend/setup.ts"],
      // The conformance exceptions in `conformance.ts` run here and must fail
      // with the outcomes and departure each entry records.
      setupFiles: ["./test/mock-backend/convexTestLane.ts"],
      // Fails the run when an excepted case did not run.
      reporters: ["default", "./test/mock-backend/conformanceReporter.ts"],
    },
  }),
);
