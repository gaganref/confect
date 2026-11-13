export { Forward } from "./internal/reservedArgument.js";
import * as ActionCallSpec from "@confect/core/ActionCall";
import * as ActionCall from "./ActionCall.js";
import * as Array from "effect/Array";
import type { FunctionSpec, RuntimeAndFunctionType } from "@confect/core";
import * as IdScope from "@confect/core/IdScope";
import type * as FunctionProvenance from "@confect/core/FunctionProvenance";
import * as Lazy from "@confect/core/Lazy";
import * as MiddlewareSpec from "@confect/core/MiddlewareSpec";
import {
  compileArgsSchema,
  compileReturnsSchema,
} from "@confect/core/SchemaToValidator";
import {
  type DefaultFunctionArgs,
  type FunctionVisibility,
  type FunctionMetadata,
  type MutationMeta,
  type QueryMeta,
  type GenericActionCtx,
  type GenericDataModel,
  type StorageReader as ConvexStorageReader,
  type RegisteredAction,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import type { PropertyValidators, Validator, Value } from "convex/values";
import { ConvexError } from "convex/values";
import { pipe } from "effect/Function";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as ConvexConfigProvider from "./ConvexConfigProvider.js";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as EffectScheduler from "effect/Scheduler";
import * as ActionCtx from "./ActionCtx.js";
import * as ActionRunner from "./ActionRunner.js";
import * as Auth from "./Auth.js";
import * as ConvexLogger from "./ConvexLogger.js";
import type * as DatabaseSchema from "./DatabaseSchema.js";
import type * as DataModel from "./DataModel.js";
import * as ExecutionMetadata from "./ExecutionMetadata.js";
import * as RequestMetadata from "./RequestMetadata.js";
import * as MutationRunner from "./MutationRunner.js";
import * as QueryRunner from "./QueryRunner.js";
import type * as ResolvedMiddleware from "./ResolvedMiddleware.js";
import * as Scheduler from "./Scheduler.js";
import * as Storage from "./Storage.js";
import * as StorageActionWriter from "./StorageActionWriter.js";
import type * as StorageReader from "./StorageReader.js";
import * as StorageWriter from "./StorageWriter.js";
import * as Tracer from "effect/Tracer";
import * as ObservabilityRuntime from "./internal/observability.js";
import * as VectorSearch from "./VectorSearch.js";
import type * as Handler from "./Handler.js";
import * as Record from "effect/Record";

export interface ReceivedValue {
  readonly value: unknown;
  readonly requestId: string;
  readonly deployment: string | undefined;
  readonly visibility?: FunctionVisibility;
}

export const Received = Context.Reference<ReceivedValue | undefined>(
  "@confect/server/RegisteredFunction/Received",
  { defaultValue: () => undefined },
);

export const invocationMetadata = (
  meta: Pick<MutationMeta, "getFunctionMetadata" | "getRequestMetadata">,
  args: DefaultFunctionArgs,
  reservedArgument?: string,
): Effect.Effect<FunctionMetadata & { readonly received?: ReceivedValue }> =>
  Effect.gen(function* () {
    const metadata = yield* Effect.promise(() => meta.getFunctionMetadata());
    if (reservedArgument === undefined) return metadata;
    const { requestId } = yield* Effect.promise(() =>
      meta.getRequestMetadata(),
    );
    const deployment = yield* Config.String("CONVEX_CLOUD_URL").pipe(
      Config.option,
      Effect.map(Option.getOrUndefined),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Convex entry point reads its deployment URL through Convex's environment before any service exists to compose it into.
      Effect.provide(ConvexConfigProvider.layer),
      Effect.orDie,
    );
    return {
      ...metadata,
      received: {
        value: args[reservedArgument],
        requestId,
        deployment,
        ...(metadata.visibility === undefined
          ? {}
          : { visibility: metadata.visibility }),
      },
    };
  });

export const Observability = Context.Reference<Layer.Layer<never> | undefined>(
  "@confect/server/Observability",
  { defaultValue: () => undefined },
);

export type Any =
  | RegisteredQuery<FunctionVisibility, DefaultFunctionArgs, any>
  | RegisteredMutation<FunctionVisibility, DefaultFunctionArgs, any>
  | RegisteredAction<FunctionVisibility, DefaultFunctionArgs, any>;

type ConfectRegisteredFunction<
  FunctionSpec_ extends FunctionSpec.AnyWithProps,
> =
  FunctionSpec.EncodedArgs<FunctionSpec_> extends infer Args_ extends
    DefaultFunctionArgs
    ? RuntimeAndFunctionType.GetFunctionType<
        FunctionSpec_["runtimeAndFunctionType"]
      > extends "query"
      ? RegisteredQuery<
          FunctionSpec.GetFunctionVisibility<FunctionSpec_>,
          Args_,
          Promise<FunctionSpec.EncodedReturns<FunctionSpec_>>
        >
      : RuntimeAndFunctionType.GetFunctionType<
            FunctionSpec_["runtimeAndFunctionType"]
          > extends "mutation"
        ? RegisteredMutation<
            FunctionSpec.GetFunctionVisibility<FunctionSpec_>,
            Args_,
            Promise<FunctionSpec.EncodedReturns<FunctionSpec_>>
          >
        : RuntimeAndFunctionType.GetFunctionType<
              FunctionSpec_["runtimeAndFunctionType"]
            > extends "action"
          ? RegisteredAction<
              FunctionSpec.GetFunctionVisibility<FunctionSpec_>,
              Args_,
              Promise<FunctionSpec.EncodedReturns<FunctionSpec_>>
            >
          : never
    : never;

export type ConvexRegisteredFunction<
  FunctionSpec_ extends FunctionSpec.AnyWithProps,
> = FunctionSpec_ extends FunctionSpec.AnyWithProps
  ? FunctionSpec.GetFunctionProvenance<FunctionSpec_> extends FunctionProvenance.Convex<
      infer Args_ extends DefaultFunctionArgs,
      infer Returns_
    >
    ? RuntimeAndFunctionType.GetFunctionType<
        FunctionSpec_["runtimeAndFunctionType"]
      > extends "query"
      ? RegisteredQuery<
          FunctionSpec.GetFunctionVisibility<FunctionSpec_>,
          Args_,
          Returns_
        >
      : RuntimeAndFunctionType.GetFunctionType<
            FunctionSpec_["runtimeAndFunctionType"]
          > extends "mutation"
        ? RegisteredMutation<
            FunctionSpec.GetFunctionVisibility<FunctionSpec_>,
            Args_,
            Returns_
          >
        : RuntimeAndFunctionType.GetFunctionType<
              FunctionSpec_["runtimeAndFunctionType"]
            > extends "action"
          ? RegisteredAction<
              FunctionSpec.GetFunctionVisibility<FunctionSpec_>,
              Args_,
              Returns_
            >
          : never
    : never
  : never;

export type RegisteredFunction<
  FunctionSpec_ extends FunctionSpec.AnyWithProps,
> =
  FunctionSpec_ extends FunctionSpec.WithFunctionProvenance<
    FunctionSpec_,
    FunctionProvenance.AnyConvex
  >
    ? ConvexRegisteredFunction<FunctionSpec_>
    : FunctionSpec_ extends FunctionSpec.WithFunctionProvenance<
          FunctionSpec_,
          FunctionProvenance.AnyConfect
        >
      ? ConfectRegisteredFunction<FunctionSpec_>
      : never;

export const toConvexDefinition = <
  Args extends PropertyValidators,
  Returns extends Validator<any, any, any>,
  Handler,
>(prepared: {
  readonly args: () => Args;
  readonly returns: () => Returns;
  readonly handler: Handler;
}): { args: Args; returns: Returns; handler: Handler } => {
  const definition = { handler: prepared.handler };
  Lazy.defineProperty(definition, "args", prepared.args);
  Lazy.defineProperty(definition, "returns", prepared.returns);
  return definition as { args: Args; returns: Returns; handler: Handler };
};

/**
 * Wrap a function's handler effect in its resolved middleware chain, per
 * invocation, after args decode. Iterated innermost-first so that the
 * first-attached (group-level, in attachment order) middleware ends up
 * outermost and runs first. Erased types: the public safety story lives at the
 * `MiddlewareSpec.MiddlewareImpl`/`MiddlewareImpl.make` signatures, and the
 * composed effect's error channel is re-accounted by
 * {@link combineErrorSchemas}.
 */
export const applyMiddleware = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>,
  invocation: MiddlewareSpec.MiddlewareOptions["invocation"],
): Effect.Effect<A, any, R> =>
  Array.reduceRight(
    resolvedMiddlewares,
    effect,
    (wrapped: Effect.Effect<any, any, any>, middleware) => {
      const context =
        "options" in middleware.middlewareSpec
          ? { options: middleware.options, invocation }
          : { invocation };
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Resolved middleware is type-erased after its public implementation boundary; its error and service channels are restored by the surrounding function contract.
      return middleware.middlewareImpl(wrapped, context);
    },
  );

/**
 * The error-schema allowlist for a function with middleware: the function's own
 * declared `error` schema unioned with every covering middleware's error
 * schema. `undefined` (⇒ every failure dies) only when neither declares
 * one—mirroring the ref-side union clients decode against.
 */
export const combineErrorSchemas = (
  error: Schema.Codec<any, any> | undefined,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>,
): Schema.Codec<any, any> | undefined => {
  const schemas = [
    ...(error !== undefined ? [error] : []),
    ...MiddlewareSpec.errorSchemas(
      Array.map(resolvedMiddlewares, ({ middlewareSpec }) => middlewareSpec),
    ),
  ];
  return schemas.length === 0
    ? undefined
    : schemas.length === 1
      ? schemas[0]
      : Schema.Union(schemas);
};

type InvocationMeta = Pick<QueryMeta, "getFunctionMetadata"> &
  Partial<Pick<MutationMeta, "getRequestMetadata">>;

type InvocationFunctionType = "query" | "mutation" | "action";

/**
 * What `@confect/test` installs on `globalThis` under {@link testInvocation}.
 * `start` runs `run` with the services of the test invocation the handler
 * belongs to, with the handler's `Date`, `Math.random` and
 * `crypto.getRandomValues` pinned to that invocation, or answers `undefined`
 * when none is bound. `functionType` decides how `Date` reads: a query or
 * mutation keeps its start time, an action follows the clock. Production never
 * installs it.
 */
type TestInvocation = {
  readonly start: <A>(
    meta: InvocationMeta,
    run: (services: Context.Context<never>) => Promise<A>,
    functionType: InvocationFunctionType,
  ) => Promise<A> | undefined;
};

const testInvocation = Symbol.for("@confect/test/Invocation");

/**
 * Run the `Effect` as a `Promise`. Inspect the complete `Exit` before encoding
 * a declared error so a typed failure cannot hide a defect.
 *
 * Any `Die` reason takes the defect path. Without a `Die`, the first `Fail` in
 * cause order is schema-encoded and thrown as a `ConvexError` outside the
 * Effect runtime so Convex surfaces its data to the client. Other failures and
 * interruptions alongside that `Fail` are ignored. Without an error schema, the
 * selected failure is treated as a defect.
 *
 * A lone `ConvexError` defect or a selected undeclared `ConvexError` failure is
 * rethrown bare so it keeps Convex's meaning. Pagination and Workpool rely on
 * its data for their control signals. Other causes with a `Die`, interrupt-only
 * or empty causes, and error-encoding failures reject with a plain `Error`
 * whose message renders the complete cause and whose `cause` holds it for
 * server diagnostics.
 *
 * A `scheduler` in `runOptions` must be passed here as a run option rather than
 * provided via `Effect.provideService` inside `effect`: the run option lands in
 * the fiber's root context, while a service provided within `effect` pops
 * before the exit/encoding wrappers this function adds. The fiber's op counter
 * survives context pops, so a cooperative yield can fire inside those wrappers.
 * Only a root-context scheduler covers them.
 *
 * Under `@confect/test`, a handler reached from a bound test invocation starts
 * with that invocation's services through `Effect.runPromiseWith`, on a fiber
 * of its own. Every other handler starts with `Effect.runPromise`.
 */
export const runHandlerPromise =
  (
    errorSchema: Schema.Codec<any, any> | undefined,
    runOptions?: {
      readonly scheduler?: EffectScheduler.Scheduler | undefined;
      readonly clock?: Clock.Clock | undefined;
      readonly invocation?:
        | Effect.Effect<
            FunctionMetadata & { readonly received?: ReceivedValue }
          >
        | undefined;
      readonly observability?: Layer.Layer<never> | undefined;
      readonly meta?: InvocationMeta | undefined;
      readonly functionType?: InvocationFunctionType | undefined;
    },
  ) =>
  <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const { observability, invocation, clock, meta, functionType } =
      runOptions ?? {};
    let encodedError: Exit.Exit<any, any> | undefined;
    let undeclared: { readonly error: unknown } | undefined;
    const observed = Effect.tapCause(effect, (cause) =>
      Effect.gen(function* () {
        const reason =
          Option.getOrUndefined(
            Array.findFirst(cause.reasons, Cause.isDieReason),
          ) ??
          Option.getOrUndefined(
            Array.findFirst(cause.reasons, Cause.isFailReason),
          );
        if (reason?._tag === "Fail" && errorSchema !== undefined) {
          encodedError = yield* Effect.exit(
            Schema.encodeEffect(errorSchema)(reason.error),
          );
          // An encoding failure is a defect, even when it dies with a ConvexError.
          if (Exit.isFailure(encodedError)) {
            const encoding = encodedError.cause;
            return yield* Cause.squash(encoding) instanceof ConvexError
              ? Effect.die(
                  new Error(Cause.pretty(encoding), { cause: encoding }),
                )
              : Effect.orDie(encodedError);
          }
        }
        // With no error schema a failure is a defect, so the root span ends as one.
        if (
          reason?._tag === "Fail" &&
          errorSchema === undefined &&
          !(reason.error instanceof ConvexError)
        ) {
          undeclared = { error: reason.error };
          return yield* Effect.die(reason.error);
        }
      }),
    );
    const withConvexError: Effect.Effect<Result.Result<A, ConvexError<any>>> =
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          observability === undefined || invocation === undefined
            ? effect
            : Effect.flatMap(
                invocation,
                ({ name, type, componentPath, received }) =>
                  Effect.useSpan(
                    name,
                    {
                      root: true,
                      attributes: { kind: type, componentPath },
                    },
                    (span) =>
                      Effect.provideService(observed, Tracer.ParentSpan, span),
                  ).pipe(Effect.provideService(Received, received)),
              ),
        );
        if (Exit.isSuccess(exit)) {
          return Result.succeed(exit.value);
        }
        if (undeclared !== undefined)
          return yield* Effect.die(undeclared.error);

        const cause =
          encodedError !== undefined && Exit.isFailure(encodedError)
            ? encodedError.cause
            : exit.cause;
        const reason =
          Option.getOrUndefined(
            Array.findFirst(cause.reasons, Cause.isDieReason),
          ) ??
          Option.getOrUndefined(
            Array.findFirst(cause.reasons, Cause.isFailReason),
          );
        if (
          encodedError === undefined &&
          reason?._tag === "Die" &&
          cause.reasons.length === 1 &&
          reason.defect instanceof ConvexError
        ) {
          return Result.fail(reason.defect);
        }

        if (reason?._tag === "Fail") {
          if (errorSchema === undefined) {
            if (reason.error instanceof ConvexError) {
              return Result.fail(reason.error);
            }
            return yield* Effect.die(reason.error);
          }
          const encoded =
            encodedError ??
            (yield* Effect.exit(
              Schema.encodeEffect(errorSchema)(reason.error),
            ));
          if (Exit.isSuccess(encoded)) {
            return Result.fail(new ConvexError(encoded.value));
          }
          return yield* Effect.die(
            new Error(Cause.pretty(encoded.cause), { cause: encoded.cause }),
          );
        }
        return yield* Effect.die(new Error(Cause.pretty(cause), { cause }));
      });
    const program = withConvexError.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Convex entry point provides the invocation's observability layer as Effect.runPromise runs the handler.
      Effect.provide(
        observability === undefined
          ? ConvexLogger.layer
          : ObservabilityRuntime.memoized(observability),
      ),
      Effect.provideService(Console.Console, globalThis.console),
      clock === undefined
        ? (self) => self
        : Effect.provideService(Clock.Clock, clock),
    );
    const started =
      meta === undefined || functionType === undefined
        ? undefined
        : (globalThis as { [testInvocation]?: TestInvocation })[
            testInvocation
          ]?.start(
            meta,
            (services) => Effect.runPromiseWith(services)(program, runOptions),
            functionType,
          );
    return (started ?? Effect.runPromise(program, runOptions)).then(
      Result.match({
        onFailure: (error) => {
          throw error;
        },
        onSuccess: (value) => value,
      }),
    );
  };

export const domainArgs = (
  args: DefaultFunctionArgs,
  reservedArgument?: string,
): DefaultFunctionArgs =>
  reservedArgument === undefined
    ? args
    : Record.fromEntries(
        Array.filter(
          Record.toEntries(args),
          ([key]) => key !== reservedArgument,
        ),
      );

export const actionFunctionBase = <
  Schema extends DatabaseSchema.AnyWithProps,
  Args,
  ConvexArgs extends DefaultFunctionArgs,
  Returns,
  ConvexReturns,
  E,
  R,
>({
  name,
  functionVisibility,
  args,
  returns,
  error,
  handler,
  resolvedMiddlewares = [],
  createLayer,
  scope = IdScope.app,
  observability,
  reservedArgument,
}: {
  name: string;
  reservedArgument?: string | undefined;
  functionVisibility: FunctionVisibility;
  args: Schema.Codec<Args, ConvexArgs>;
  returns: Schema.Codec<Returns, ConvexReturns>;
  error: Schema.Codec<Error, Value> | undefined;
  handler: (a: Args) => Effect.Effect<Returns, E, R>;
  resolvedMiddlewares?: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>;
  createLayer: (
    ctx: GenericActionCtx<DataModel.ToConvex<DataModel.FromSchema<Schema>>>,
  ) => Layer.Layer<R>;
  scope?: IdScope.IdScope;
  observability?: Layer.Layer<never> | undefined;
}) => ({
  args: () => compileArgsSchema(args, scope, reservedArgument, name),
  returns: () => compileReturnsSchema(returns, scope),
  handler: (
    ctx: GenericActionCtx<DataModel.ToConvex<DataModel.FromSchema<Schema>>>,
    actualArgs: ConvexArgs,
  ): Promise<ConvexReturns> =>
    Effect.gen(function* () {
      const decodedArgs = yield* pipe(
        domainArgs(actualArgs, reservedArgument),
        Schema.decodeUnknownEffect(args),
        Effect.catchTag("SchemaError", Effect.die),
      );
      const restricted = Array.some(
        resolvedMiddlewares,
        ({ middlewareSpec }) =>
          middlewareSpec.key === ActionCallSpec.Middleware.key,
      )
        ? restrict(ctx)
        : undefined;
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Middleware errors are intentionally erased here and validated by runHandlerPromise against the combined error schema below.
      const decodedReturns = yield* applyMiddleware(
        handler(decodedArgs),
        resolvedMiddlewares,
        {
          name,
          functionType: "action",
          functionVisibility,
          args: decodedArgs,
        },
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Convex entry point provides invocation-local services before runHandlerPromise executes the handler.
      ).pipe(Effect.provide(createLayer(restricted?.ctx ?? ctx)));
      if (restricted !== undefined) yield* restricted.check;
      return yield* pipe(
        decodedReturns,
        Schema.encodeEffect(returns),
        Effect.catchTag("SchemaError", Effect.die),
      );
    }).pipe(
      runHandlerPromise(combineErrorSchemas(error, resolvedMiddlewares), {
        invocation: invocationMetadata(ctx.meta, actualArgs, reservedArgument),
        observability,
        meta: ctx.meta,
        functionType: "action",
      }),
    ),
});

export type ActionServices<
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
> = Handler.ActionServices<DatabaseSchema_>;

/**
 * The ctx-backed action services that don't depend on a Confect database
 * schema. {@link actionLayer} adds the schema-typed `VectorSearch` on top; the
 * HTTP API handler uses this base directly.
 */
export const baseActionLayer = <ConvexDataModel extends GenericDataModel>(
  ctx: GenericActionCtx<ConvexDataModel>,
) =>
  Layer.mergeAll(
    Scheduler.layer(ctx.scheduler),
    Auth.layer(ctx.auth),
    ExecutionMetadata.layer(ctx.meta),
    RequestMetadata.layer(ctx.meta),
    Storage.layer(ctx.storage),
    StorageWriter.StorageWriter.layer(ctx.storage),
    StorageActionWriter.StorageActionWriter.layer(ctx.storage),
    QueryRunner.layer(ctx.runQuery.bind(ctx)),
    MutationRunner.layer(ctx.runMutation.bind(ctx)),
    ActionRunner.layer(ctx.runAction.bind(ctx)),
    Layer.succeed(ActionCtx.ActionCtx<ConvexDataModel>(), ctx),
  );

export const actionLayer = <
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
>(
  databaseSchema: DatabaseSchema_,
  ctx: GenericActionCtx<
    DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>
  >,
) =>
  Layer.mergeAll(
    Scheduler.layer<DatabaseSchema.Scope<DatabaseSchema_>>(
      ctx.scheduler,
      databaseSchema.target.scope,
    ),
    Auth.layerForTarget<DatabaseSchema_["target"]>(
      databaseSchema.target,
      ctx.auth,
    ),
    ExecutionMetadata.layer(ctx.meta),
    RequestMetadata.layer(ctx.meta),
    storageLayer<DatabaseSchema.Scope<DatabaseSchema_>>(ctx.storage),
    StorageWriter.StorageWriter.layer<DatabaseSchema.Scope<DatabaseSchema_>>(
      ctx.storage,
      databaseSchema.target.scope,
    ),
    StorageActionWriter.StorageActionWriter.layer<
      DatabaseSchema.Scope<DatabaseSchema_>
    >(ctx.storage, databaseSchema.target.scope),
    QueryRunner.layer(ctx.runQuery.bind(ctx)),
    MutationRunner.layer(ctx.runMutation.bind(ctx)),
    ActionRunner.layer(ctx.runAction.bind(ctx)),
    ActionCtx.layer<
      DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>,
      DatabaseSchema.Scope<DatabaseSchema_>
    >(ctx, databaseSchema.target.scope),
    VectorSearch.layer(ctx.vectorSearch.bind(ctx)),
  );

// Scoped readers share the same runtime service and ID strings. Reuse the
// reader supplied by Storage so both APIs keep the same reader instance.
export const storageLayer = <Scope extends IdScope.IdScope>(
  reader: ConvexStorageReader,
): Layer.Layer<Storage.Storage | StorageReader.ForScope<Scope>> =>
  Storage.layer(reader) as Layer.Layer<
    Storage.Storage | StorageReader.ForScope<Scope>
  >;

/**
 * Shares one dispatch budget across the entire middleware chain.
 */
const restrict = <Model extends GenericDataModel>(
  ctx: GenericActionCtx<Model>,
) => {
  let dispatched = false;
  const claim = () => {
    if (dispatched) throw ActionCall.ActionCallAlreadyUsed.make({});
    dispatched = true;
  };
  const restricted: GenericActionCtx<Model> = {
    ...ctx,
    scheduler: {
      runAfter: () => {
        throw ActionCall.SchedulingNotAllowed.make({});
      },
      runAt: () => {
        throw ActionCall.SchedulingNotAllowed.make({});
      },
      cancel: () => {
        throw ActionCall.SchedulingNotAllowed.make({});
      },
    },
    runQuery: (...args) => {
      claim();
      return ctx.runQuery(...args);
    },
    runMutation: (...args) => {
      claim();
      return ctx.runMutation(...args);
    },
    runAction: () => {
      throw ActionCall.NestedActionNotAllowed.make({});
    },
  };
  return {
    ctx: restricted,
    check: Effect.suspend(() =>
      dispatched
        ? Effect.void
        : Effect.die(ActionCall.ActionCallNotUsed.make({})),
    ),
  };
};
