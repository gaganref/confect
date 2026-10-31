import * as Effect from "effect/Effect";
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
    Effect.cached,
    Effect.runSync,
    Effect.uninterruptible,
    Layer.effectContext,
  );
  layers.set(layer, built);
  return built;
};
