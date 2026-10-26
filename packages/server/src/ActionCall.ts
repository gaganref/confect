import * as ActionCall from "@confect/core/ActionCall";
import * as Ref from "@confect/core/Ref";
import type { FunctionReference } from "convex/server";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
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

export class ActionCallAlreadyUsed extends Data.TaggedError(
  "ActionCallAlreadyUsed",
)<{}> {}
export class ActionCallNotUsed extends Data.TaggedError(
  "ActionCallNotUsed",
)<{}> {}
export class MissingFunctionType extends Data.TaggedError(
  "MissingFunctionType",
)<{}> {}
export class NestedActionNotAllowed extends Data.TaggedError(
  "NestedActionNotAllowed",
)<{}> {}

export class SchedulingNotAllowed extends Data.TaggedError(
  "SchedulingNotAllowed",
)<{}> {}

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
          if (claimed) return Effect.die(new ActionCallAlreadyUsed());
          claimed = true;
          if (ref.functionType !== "query" && ref.functionType !== "mutation")
            return Effect.die(new MissingFunctionType());
          return Ref.runWithCodec(
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
        });
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
