import * as NodeServices from "../fixtures/NodeTestServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RealBackend from "./RealBackend";

// A module stays in the registry once imported, so the clean run comes first.
it.effect("fails a test that loads package source after make", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(NodeServices.layer);
    return yield* Effect.gen(function* () {
      const harness = RealBackend.make({ name: "guard", ports: "4600-4699" });
      yield* Effect.scoped(harness);
      const exit = yield* harness.pipe(
        Effect.andThen(Effect.promise(() => import("@confect/core/Ref"))),
        Effect.scoped,
        Effect.exit,
      );
      expect(String(exit)).toContain("loaded their source");
    }).pipe(Effect.provideContext(services));
  }),
);

it("reads a Windows registry as it reads a POSIX one", () => {
  const harness = "D:\\a\\confect\\packages\\alchemy\\test\\RealBackend.ts";
  const registry = RealBackend.readRegistry(
    [
      "D:/a/confect/packages/alchemy/test/RealBackend.ts",
      "D:\\a\\confect\\packages\\core\\src\\Ref.ts",
    ],
    harness,
  );
  expect(registry.listsHarness).toBe(true);
  expect(registry.source).toEqual(["D:/a/confect/packages/core/src/Ref.ts"]);
  expect(
    RealBackend.readRegistry(
      ["/work/confect/packages/alchemy/test/Other.ts"],
      harness,
    ).listsHarness,
  ).toBe(false);
});
