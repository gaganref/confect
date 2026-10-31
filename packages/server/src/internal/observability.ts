import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ConvexConfigProvider from "../ConvexConfigProvider.js";

const memoMap = Layer.makeMemoMapUnsafe();
export const scope = Scope.makeUnsafe();
const layers = new WeakMap<Layer.Layer<never>, Layer.Layer<never>>();

export const memoized = (layer: Layer.Layer<never>): Layer.Layer<never> => {
  const cached = layers.get(layer);
  if (cached !== undefined) return cached;
  const built = Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
    Effect.provide(ConvexConfigProvider.layer),
    // A failed first build is retried on the next invocation instead of failing every later one.
    Effect.cachedWithTTL((exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
    ),
    Effect.runSync,
    Effect.uninterruptible,
    Layer.effectContext,
  );
  layers.set(layer, built);
  return built;
};
