import * as ReservedArgument from "./internal/reservedArgument.js";
import * as ActionCall from "@confect/core/ActionCall";
import type * as Ref from "@confect/core/Ref";
import type { FunctionReference } from "convex/server";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as ActionCtx from "./ActionCtx.js";
import * as ActionRunner from "./ActionRunner.js";
import type * as DatabaseSchema from "./DatabaseSchema.js";
import type * as DataModel from "./DataModel.js";
import type * as Handler from "./Handler.js";
import * as MiddlewareImpl from "./MiddlewareImpl.js";
import * as MutationRunner from "./MutationRunner.js";
import * as QueryRunner from "./QueryRunner.js";
import * as Scheduler from "./Scheduler.js";

export class ActionCallAlreadyUsed extends Schema.TaggedError<
  ActionCallAlreadyUsed,
  { readonly brand: unique symbol }
>()("ActionCallAlreadyUsed", {}) {}
export class ActionCallNotUsed extends Schema.TaggedError<
  ActionCallNotUsed,
  { readonly brand: unique symbol }
>()("ActionCallNotUsed", {}) {}
export class MissingFunctionType extends Schema.TaggedError<
  MissingFunctionType,
  { readonly brand: unique symbol }
>()("MissingFunctionType", {}) {}
export class NestedActionNotAllowed extends Schema.TaggedError<
  NestedActionNotAllowed,
  { readonly brand: unique symbol }
>()("NestedActionNotAllowed", {}) {}

export class SchedulingNotAllowed extends Schema.TaggedError<
  SchedulingNotAllowed,
  { readonly brand: unique symbol }
>()("SchedulingNotAllowed", {}) {}

export const layer = <S extends DatabaseSchema.AnyWithProps>(schema: S) =>
  MiddlewareImpl.make(schema, ActionCall.Middleware, (effect) =>
    Effect.gen(function* () {
      const ctx = yield* ActionCtx.ActionCtx<
        DataModel.ToConvex<DataModel.FromSchema<S>>,
        DatabaseSchema.Scope<S>
      >();
      let claimed = false;
      const call: ActionCall.Call = <
        Target extends Ref.AnyQuery | Ref.AnyMutation,
      >(
        ref: Target,
        ...args: Ref.OptionalArgs<NoInfer<Target>>
      ) =>
        Effect.suspend(() => {
          if (claimed) return Effect.die(ActionCallAlreadyUsed.make({}));
          claimed = true;
          if (ref.functionType !== "query" && ref.functionType !== "mutation")
            return Effect.die(MissingFunctionType.make({}));
          return ReservedArgument.runWithCodec(
            ref,
            (args[0] ?? {}) as Ref.Args<Target>,
            (native, encoded) =>
              ref.functionType === "query"
                ? ctx.runQuery(
                    native as FunctionReference<"query">,
                    encoded as never,
                  )
                : ctx.runMutation(
                    native as FunctionReference<"mutation">,
                    encoded as never,
                  ),
          );
        }).pipe(Effect.withSpan("ActionCall.call"));
      return yield* effect.pipe(
        Effect.provideService(ActionCall.ActionCall, call),
        Effect.updateContext(
          (context: Context.Context<Handler.ActionServices<S>>) =>
            Context.omit(
              QueryRunner.QueryRunner,
              MutationRunner.MutationRunner,
              ActionRunner.ActionRunner,
              ActionCtx.ActionCtx(),
              Scheduler.Scheduler,
            )(context),
        ),
      );
    }),
  );
