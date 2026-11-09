import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RealBackend from "./RealBackend";

// A module stays in the registry once imported, so the clean run comes first.
it.effect("fails a test that loads package source after make", () =>
  Effect.gen(function* () {
    const harness = RealBackend.make({ name: "guard", ports: "4600-4699" });
    yield* Effect.scoped(harness);
    const exit = yield* harness.pipe(
      Effect.andThen(Effect.promise(() => import("@confect/core/Ref"))),
      Effect.scoped,
      Effect.exit,
    );
    expect(String(exit)).toContain("loaded their source");
  }).pipe(Effect.provide(NodeServices.layer)),
);
