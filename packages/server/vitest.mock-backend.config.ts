import { createRequire } from "node:module";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vitest config needs synchronous path resolution before an Effect runtime exists.
import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared";

/**
 * Conformance exceptions: mock-backend cases that hold the Convex binary's
 * behaviour where convex-test does otherwise, so this lane cannot run them. The
 * lane records an exception the way it records `kernelLane.test.ts`, by
 * excluding its file, so each file holds exactly the one case its entry names.
 * The kernel lane runs every one. An entry checked against another convex-test
 * version than the installed one fails the lane, so a bump re-checks it.
 */
const exceptions: ReadonlyArray<{
  readonly file: string;
  readonly name: string;
  readonly convexTest: string;
  readonly binary: string;
  readonly owner: string;
  readonly evidence: string;
}> = [
  {
    file: "test/mock-backend/httpRouteError.test.ts",
    name: "HTTP route errors > a root route that throws an Error answers the binary's 500 JSON error body",
    convexTest: "0.0.65",
    binary:
      'The binary answers 500, application/json, {"code":"[Request ID: <16 hex>] Server Error: Uncaught Error: <message>","trace":"Uncaught Error: <message>\\n    at …\\n"}. convex-test rejects the fetch with the thrown Error.',
    owner: "@confect/test kernel, build-order row 6 (HTTP and signed ingress)",
    evidence:
      "packages/server/test/local-backend/httpErrors.test.ts > HTTP route errors on the binary > a route that throws an Error answers 500 with the redacted-error JSON body, on precompiled-2026-10-28-cccbade. convex-backend cccbade: Application::run_http_action sends RedactedJsError::to_http_response_parts (crates/application/src/lib.rs:1542-1548), which builds the body (crates/application/src/redaction.rs:143-160) through HttpActionResponsePart::from_json (crates/udf/src/http_action.rs:133-141).",
  },
  {
    file: "test/mock-backend/httpRouteConvexError.test.ts",
    name: "HTTP route errors > a root route that throws a ConvexError answers the binary's 500 JSON error body with its data",
    convexTest: "0.0.65",
    binary:
      "The binary answers 500, application/json, with code and trace naming Uncaught ConvexError and the error's JSON, and data holding the ConvexError's data. convex-test rejects the fetch with the thrown ConvexError.",
    owner: "@confect/test kernel, build-order row 6 (HTTP and signed ingress)",
    evidence:
      "packages/server/test/local-backend/httpErrors.test.ts > HTTP route errors on the binary > a route that throws a ConvexError answers 500 with its data, on precompiled-2026-10-28-cccbade. convex-backend cccbade: custom_data_if_any adds data (crates/application/src/redaction.rs:156-158).",
  },
];

const convexTestVersion = (
  createRequire(import.meta.url)("convex-test/package.json") as {
    readonly version: string;
  }
).version;
const stale = exceptions.filter(
  ({ convexTest }) => convexTest !== convexTestVersion,
);
if (stale.length > 0) {
  throw new Error(
    `The convex-test lane's exceptions were checked against another convex-test than ${convexTestVersion}: ${stale.map(({ file }) => file).join(", ")}. Re-check each and update its version.`,
  );
}

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
      // The kernel lane's own controls run only there, as do the conformance
      // exceptions above.
      exclude: [
        "test/mock-backend/kernelLane.test.ts",
        ...exceptions.map(({ file }) => file),
      ],
      globalSetup: ["./test/mock-backend/setup.ts"],
    },
  }),
);
