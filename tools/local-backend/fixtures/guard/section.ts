import type { ManifestSection } from "@confect/core";

/**
 * A manifest section whose generated file declares a push check that asks
 * `confect/guard.ts` of its own target for its refusals. `router` sections are
 * imported by the HTTP router alone.
 */
export const guardSection = (
  key: "functions" | "router",
): ManifestSection.Entry => ({
  key,
  section: {
    owner: "fixture/guard",
    format: 1,
    describe: () => null,
    generate: {
      file: `${key}.ts`,
      match: () => false,
      render: () => ({
        contents: `import * as PushCheck from "@confect/server/PushCheck";
import { refusals } from "../guard";

export const pushCheck = PushCheck.make("${key}", () => refusals("${key}"));
`,
        errors: [],
      }),
      pushCheck: true,
      ...(key === "router" ? { importedByFunctions: false } : {}),
    },
  },
});
