import * as Ref from "@confect/core/Ref";
import type {
  DefaultFunctionArgs,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ActionCtx from "./ActionCtx.js";
import type * as ActionRunner from "./ActionRunner.js";
import * as MutationCtx from "./MutationCtx.js";
import type * as MutationRunner from "./MutationRunner.js";
import * as QueryCtx from "./QueryCtx.js";
import type * as QueryRunner from "./QueryRunner.js";

/**
 * An official component's method rejected. `cause` is the rejection as thrown.
 */
export class ComponentCallFailed extends Schema.TaggedError<ComponentCallFailed>()(
  "ComponentCallFailed",
  { component: Schema.String, method: Schema.String, cause: Schema.Defect() },
) {}

declare const unsupported: unique symbol;
type Unsupported = typeof unsupported;
type Needs<Param> = [GenericActionCtx<GenericDataModel>] extends [Param]
  ? [GenericMutationCtx<GenericDataModel>] extends [Param]
    ? [GenericQueryCtx<GenericDataModel>] extends [Param]
      ? QueryRunner.QueryRunner
      : MutationRunner.MutationRunner
    : [GenericQueryCtx<GenericDataModel>] extends [Param]
      ? Unsupported
      : ActionRunner.ActionRunner
  : Unsupported;

type Method<Official> = {
  [K in keyof Official & string]: Official[K] extends (
    ctx: infer Ctx,
    ...args: never[]
  ) => Promise<unknown>
    ? Needs<Ctx> extends Unsupported
      ? never
      : K
    : never;
}[keyof Official & string];

type Call<F> = F extends (
  ctx: infer Ctx,
  ...args: infer Args
) => Promise<infer A>
  ? (...args: Args) => Effect.Effect<A, never, Needs<Ctx>>
  : never;

type Lifted<Official> = <M extends Method<Official>>(
  method: M,
  ...args: Parameters<Call<Official[M]>>
) => ReturnType<Call<Official[M]>>;

/**
 * Lift official promise methods, deriving each capability from its ctx
 * parameter. A rejection is caller misuse, a limit or a platform fault rather
 * than a domain fact, so it dies.
 */
export const make = <Official extends object>(
  component: string,
  official: Official,
): Lifted<Official> => {
  const context = Effect.gen(function* () {
    const action = yield* Effect.serviceOption(
      ActionCtx.ActionCtx<GenericDataModel>(),
    );
    if (Option.isSome(action)) return action.value;
    const mutation = yield* Effect.serviceOption(
      MutationCtx.MutationCtx<GenericDataModel>(),
    );
    if (Option.isSome(mutation)) return mutation.value;
    const query = yield* Effect.serviceOption(
      QueryCtx.QueryCtx<GenericDataModel>(),
    );
    if (Option.isSome(query)) return query.value;
    return yield* Effect.die(
      new Error(`${component} called outside a Confect handler`),
    );
  });
  const call = Effect.fn(`${component}.call`)(function* (
    method: Method<Official>,
    ...args: unknown[]
  ) {
    const ctx = yield* context;
    // Method selects promise methods whose first argument accepts a native handler context.
    const invoke = official[method] as (
      native: typeof ctx,
      ...args: unknown[]
    ) => Promise<unknown>;
    return yield* Effect.tryPromise({
      try: () => invoke.call(official, ctx, ...args),
      catch: (cause) => ComponentCallFailed.make({ component, method, cause }),
    }).pipe(Effect.orDie);
  });
  // Confect installs the native ctx with the runner capability inferred by Needs.
  return call as unknown as Lifted<Official>;
};

/**
 * A function reference with its encoded arguments, ready for an official method
 * that takes both.
 */
export interface Fn<R extends Ref.Any> {
  readonly reference: Ref.FunctionReference<R>;
  readonly args: DefaultFunctionArgs;
}

/**
 * Encode a ref's arguments through its codecs to the wire record an official
 * method expects.
 */
export const encodeCall = <R extends Ref.Any>(
  ref: R,
  args: NoInfer<Ref.Args<R>>,
): Effect.Effect<Fn<R>> =>
  Ref.encodeArgs(ref, args).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown)),
    ),
    Effect.map((encoded) => ({
      reference: Ref.getFunctionReference(ref),
      args: encoded,
    })),
    Effect.orDie,
  );

/**
 * Encode a callback's real field without fabricating the rest of its arguments.
 */
export const encodeField = <
  R extends Ref.AnyConfect,
  K extends keyof Ref.Args<R> & keyof Ref.ArgsFields<R>,
>(
  ref: R,
  key: K,
  value: NoInfer<Ref.Args<R>[K]>,
): Effect.Effect<unknown> => {
  const fields = ref.args.fields as Record<
    keyof Ref.ArgsFields<R>,
    Schema.Codec<unknown, unknown>
  >;
  return Schema.encodeUnknownEffect(fields[key])(value).pipe(Effect.orDie);
};
