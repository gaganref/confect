import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as FunctionSpec from "./FunctionSpec.js";
import * as MiddlewareSpec from "./MiddlewareSpec.js";
import type * as Ref from "./Ref.js";

export interface Call {
  <Target extends Ref.AnyQuery | Ref.AnyMutation>(
    target: Target,
    ...args: Ref.OptionalArgs<NoInfer<Target>>
  ): Effect.Effect<Ref.Returns<Target>, Ref.Error<Target> | Schema.SchemaError>;
}

export class ActionCall extends Context.Service<ActionCall, Call>()(
  "@confect/core/ActionCall",
) {}
export class Middleware extends MiddlewareSpec.MiddlewareSpec<
  Middleware,
  { provides: ActionCall }
>()("@confect/core/ActionCall/Middleware", {
  functionTypes: { query: false, mutation: false, action: true },
}) {}

export const profile = FunctionSpec.extend()({ middleware: [Middleware] });
