import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expectServerError } from "./serverError";
import * as TestConfect from "./TestConfect";
import * as Layer from "effect/Layer";

// A convex-test lane exception: `vitest.mock-backend.config.ts` records it.
// This file holds that entry's one case.
describe("HTTP route errors", () => {
  it.effect(
    "a root route that throws an Error answers the binary's 500 JSON error body",
    () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(TestConfect.layer);
        return yield* Effect.gen(function* () {
          const c = yield* TestConfect.TestConfect;
          const fetch2 = yield* c.fetch("/convex-native/throws");
          yield* expectServerError(fetch2, "Uncaught Error: The route failed.");
        }).pipe(Effect.provideContext(services));
      }).pipe(Effect.scoped),
  );
});
