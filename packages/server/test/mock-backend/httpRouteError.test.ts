import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { departs, recordOutcomes } from "./conformance";
import { expectServerError, fetchOutcome } from "./serverError";
import * as TestConfect from "./TestConfect";

// A convex-test lane exception: `conformance.ts` records it, and convex-test
// rejects the fetch with the thrown error where the binary answers 500.
describe("HTTP route errors", () => {
  it.effect(
    "a root route that throws an Error answers the binary's 500 JSON error body",
    ({ task }) =>
      Effect.gen(function* () {
        const services = yield* Layer.build(TestConfect.layer);
        return yield* Effect.gen(function* () {
          const c = yield* TestConfect.TestConfect;
          const { outcome, response } = yield* fetchOutcome(
            "GET /convex-native/throws",
            c.fetch("/convex-native/throws"),
          );
          recordOutcomes(task, [outcome]);
          // The departure: on convex-test the fetch rejects instead.
          departs(task, () =>
            expect(outcome).toEqual({
              function: "GET /convex-native/throws",
              returned: 500,
            }),
          );
          if (response !== undefined) {
            yield* expectServerError(
              response,
              "Uncaught Error: The route failed.",
            );
          }
        }).pipe(Effect.provideContext(services));
      }).pipe(Effect.scoped),
  );
});
