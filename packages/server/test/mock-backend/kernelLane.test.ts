import { describe, expect, it } from "@effect/vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
// Imported by relative path, as in `TestConfect.ts`.
import { ownsConvexGlobal } from "../../../test/src/internal/Execution";
import convexSchema from "./fixtures/confect/_generated/convexSchema";

// Runs only in the kernel lane (`vitest.mock-backend.kernel.config.ts`).
describe("the kernel lane", () => {
  it.effect("answers convex-test's convexTest with the test kernel", () =>
    Effect.gen(function* () {
      const t = convexTest(convexSchema, {
        ...import.meta.glob("./fixtures/convex/_generated/*.js"),
      });
      const failure = yield* Effect.promise(() =>
        t.query(makeFunctionReference<"query">("missing:read"), {}).then(
          () => "answered",
          (error: Error) => error.message,
        ),
      );
      expect(failure).toBe('Could not find module for: "missing"');
      expect(ownsConvexGlobal()).toBe(true);
    }),
  );

  it.effect("refuses to load the installed convex-test package", () =>
    Effect.gen(function* () {
      // Built at run time so the import resolves through the lane's plugins
      // when the case runs, not when the file is transformed.
      const specifier = ["convex-test", "dist", "index.js"].join("/");
      const refusal = yield* Effect.promise(() =>
        import(/* @vite-ignore */ specifier).then(
          () => "loaded",
          (error: Error) => error.message,
        ),
      );
      expect(refusal).toContain("The kernel lane refuses convex-test");
    }),
  );
});
