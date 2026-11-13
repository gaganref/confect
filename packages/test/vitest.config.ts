import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globalSetup: ["../server/test/local-backend/setup.ts"],
      // Guards the host APIs Convex refuses before any test module loads.
      setupFiles: ["./src/setup.ts"],
    },
  }),
);
