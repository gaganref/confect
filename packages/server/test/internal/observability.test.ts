import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { memoized } from "../../src/internal/observability";

describe("memoized", () => {
  it.effect("rebuilds a layer whose first build failed", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const layer = Layer.effectDiscard(
        Effect.suspend(() =>
          ++attempts === 1 ? Effect.die("first build") : Effect.void,
        ),
      );
      const use = Effect.scoped(Layer.build(memoized(layer)));
      expect(Exit.isFailure(yield* Effect.exit(use))).toBe(true);
      yield* use;
      yield* use;
      expect(attempts).toBe(2);
    }),
  );
});
