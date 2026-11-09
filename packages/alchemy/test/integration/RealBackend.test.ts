import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as RealBackend from "./RealBackend";

describe("the real-backend harness", () => {
  const harness = RealBackend.make({ name: "guard", ports: "4600-4699" });

  // One test, in this order: a module stays in the registry once a file
  // imports it, so the clean run has to come first.
  it.effect(
    "passes a test that loads only built packages and fails one that loads package source after it starts",
    () =>
      Effect.gen(function* () {
        expect(Exit.isSuccess(yield* Effect.exit(Effect.scoped(harness)))).toBe(
          true,
        );
        const exit = yield* harness.pipe(
          Effect.andThen(Effect.promise(() => import("@confect/core/Ref"))),
          Effect.scoped,
          Effect.exit,
        );
        expect(
          Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "no failure",
        ).toContain("loaded their source");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
