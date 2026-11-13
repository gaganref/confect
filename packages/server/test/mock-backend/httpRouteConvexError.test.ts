import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expectServerError } from "./serverError";
import * as TestConfect from "./TestConfect";
import * as Layer from "effect/Layer";

// A convex-test lane exception: `vitest.mock-backend.config.ts` records it.
// This file holds that entry's one case.
describe("HTTP route errors", () => {
  it.effect(
    "a root route that throws a ConvexError answers the binary's 500 JSON error body with its data",
    () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(TestConfect.layer);
        return yield* Effect.gen(function* () {
          const c = yield* TestConfect.TestConfect;
          const fetch2 = yield* c.fetch("/convex-native/throws-convex-error");
          yield* expectServerError(
            fetch2,
            'Uncaught ConvexError: {"code":"denied","attempt":2}',
            { attempt: 2, code: "denied" },
          );
        }).pipe(Effect.provideContext(services));
      }).pipe(Effect.scoped),
  );
});
