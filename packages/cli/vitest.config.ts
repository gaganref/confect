import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [tsconfigPaths()],
    test: {
      root: import.meta.dirname,
      include: ["test/*.test.ts", "test/integration/*.test.ts"],
      // A slow Windows runner measured 5.0s against the 5s default timeout.
      ...(process.platform === "win32"
        ? { testTimeout: 15_000, hookTimeout: 15_000 }
        : {}),
    },
  }),
);
