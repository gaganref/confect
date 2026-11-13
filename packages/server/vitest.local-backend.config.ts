import { fileURLToPath } from "node:url";
import { defineLocalBackendConfig } from "confect-local-backend/vitest";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared";

export default mergeConfig(
  defineLocalBackendConfig({
    base: sharedConfig,
    root: import.meta.dirname,
    name: "@confect/server",
  }),
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, "**/*.spec.ts"],
      globalSetup: [
        fileURLToPath(
          import.meta.resolve("confect-local-backend/consumerSetup"),
        ),
      ],
    },
  }),
);
