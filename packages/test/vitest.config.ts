import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globalSetup: ["../../tools/local-backend/src/setup.ts"],
    },
  }),
);
