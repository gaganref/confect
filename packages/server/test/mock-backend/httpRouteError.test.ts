import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expectServerError } from "./serverError";
import * as TestConfect from "./TestConfect";

// A convex-test lane exception: `vitest.mock-backend.config.ts` records it.
// This file holds that entry's one case.
describe("HTTP route errors", () => {
  it.effect(
    "a root route that throws an Error answers the binary's 500 JSON error body",
    () =>
      Effect.gen(function* () {
        const c = yield* TestConfect.TestConfect;
        yield* expectServerError(
          yield* c.fetch("/convex-native/throws"),
          "Uncaught Error: The route failed.",
        );
      }).pipe(Effect.provide(TestConfect.layer)),
  );
});
