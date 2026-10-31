import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ConvexConfigProvider from "../ConvexConfigProvider.js";

const memoMap = Layer.makeMemoMapUnsafe();
export const scope = Scope.makeUnsafe();

export const memoized = (layer: Layer.Layer<never>): Layer.Layer<never> =>
  Layer.effectContext(Layer.buildWithMemoMap(layer, memoMap, scope)).pipe(
    Layer.provide(ConvexConfigProvider.layer),
  );
