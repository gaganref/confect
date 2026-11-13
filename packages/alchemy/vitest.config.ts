import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    resolve: {
      // The built push imports the mount traversal it shares with the test
      // backend, and the real-backend harness runs only built packages, so
      // this one import resolves to core's build instead of its source.
      alias: [
        {
          find: /^@confect\/core\/MountSteps$/,
          replacement: new URL("../core/dist/MountSteps.js", import.meta.url)
            .pathname,
        },
      ],
    },
    test: {
      name: "@confect/alchemy",
      root: import.meta.dirname,
      include: ["test/**/*.test.ts"],
    },
  }),
);
