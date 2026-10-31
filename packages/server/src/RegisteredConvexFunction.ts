import {
  compileArgsSchema,
  compileReturnsSchema,
} from "@confect/core/SchemaToValidator";
import {
  actionGeneric,
  type DefaultFunctionArgs,
  type FunctionVisibility,
  type GenericMutationCtx,
  type GenericQueryCtx,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type { Value } from "convex/values";
import { pipe } from "effect/Function";
import type * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as EffectScheduler from "effect/Scheduler";
import * as Auth from "./Auth.js";
import * as ConvexConfigProvider from "./ConvexConfigProvider.js";
import * as DatabaseReader from "./DatabaseReader.js";
import type * as DatabaseSchema from "./DatabaseSchema.js";
import * as DatabaseWriter from "./DatabaseWriter.js";
import type * as DataModel from "./DataModel.js";
import * as ExecutionMetadata from "./ExecutionMetadata.js";
import * as RequestMetadata from "./RequestMetadata.js";
import * as TransactionMetadata from "./TransactionMetadata.js";
import * as MutationCtx from "./MutationCtx.js";
import * as MutationRunner from "./MutationRunner.js";
import * as MutationTransactionContext from "./MutationTransactionContext.js";
import * as QueryCtx from "./QueryCtx.js";
import * as QueryRunner from "./QueryRunner.js";
import * as QueryTransactionContext from "./QueryTransactionContext.js";
import * as RegisteredFunction from "./RegisteredFunction.js";
import type * as FunctionRegistryItem from "./FunctionRegistryItem.js";
import type * as ResolvedMiddleware from "./ResolvedMiddleware.js";
import * as Scheduler from "./Scheduler.js";
import { StorageWriter } from "./StorageWriter.js";
import type * as Handler from "./Handler.js";

export type Definition = Data.TaggedEnum<{
  PublicQuery: ReturnType<typeof queryFunction>;
  InternalQuery: ReturnType<typeof queryFunction>;
  PublicMutation: ReturnType<typeof mutationFunction>;
  InternalMutation: ReturnType<typeof mutationFunction>;
  PublicAction: ReturnType<typeof convexActionFunction>;
  InternalAction: ReturnType<typeof convexActionFunction>;
  Registered: { readonly handler: RegisteredFunction.Any };
}>;
export const Definition = Data.taggedEnum<Definition>();

export const prepare = (
  databaseSchema: DatabaseSchema.AnyWithProps,
  item: FunctionRegistryItem.ConfectFunctionRegistryItem,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware> = [],
  observability?: Layer.Layer<never>,
) =>
  Match.value(item.functionType).pipe(
    Match.when("query", () => {
      const definition = queryFunction({
        databaseSchema,
        name: item.name,
        observability: observability?.pipe(
          Layer.provide(ConvexConfigProvider.layer),
        ),
        functionVisibility: item.functionVisibility,
        args: item.args,
        returns: item.returns,
        error: item.error,
        handler: item.handler,
        resolvedMiddlewares,
      });
      return Match.value(item.functionVisibility).pipe(
        Match.when("public", () => Definition.PublicQuery(definition)),
        Match.when("internal", () => Definition.InternalQuery(definition)),
        Match.exhaustive,
      );
    }),
    Match.when("mutation", () => {
      const definition = mutationFunction({
        databaseSchema,
        name: item.name,
        observability: observability?.pipe(
          Layer.provide(ConvexConfigProvider.layer),
        ),
        functionVisibility: item.functionVisibility,
        args: item.args,
        returns: item.returns,
        error: item.error,
        handler: item.handler,
        resolvedMiddlewares,
      });
      return Match.value(item.functionVisibility).pipe(
        Match.when("public", () => Definition.PublicMutation(definition)),
        Match.when("internal", () => Definition.InternalMutation(definition)),
        Match.exhaustive,
      );
    }),
    Match.when("action", () => {
      const definition = convexActionFunction(databaseSchema, {
        name: item.name,
        observability: observability?.pipe(
          Layer.provide(ConvexConfigProvider.layer),
        ),
        functionVisibility: item.functionVisibility,
        args: item.args,
        returns: item.returns,
        error: item.error,
        handler: item.handler,
        resolvedMiddlewares,
      });
      return Match.value(item.functionVisibility).pipe(
        Match.when("public", () => Definition.PublicAction(definition)),
        Match.when("internal", () => Definition.InternalAction(definition)),
        Match.exhaustive,
      );
    }),
    Match.exhaustive,
  );

export const make = (
  databaseSchema: DatabaseSchema.AnyWithProps,
  item: FunctionRegistryItem.ConfectFunctionRegistryItem,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware> = [],
): RegisteredFunction.Any =>
  register(prepare(databaseSchema, item, resolvedMiddlewares));

export const register = (self: Definition): RegisteredFunction.Any =>
  Definition.$match(self, {
    PublicQuery: (definition) => queryGeneric(definition),
    InternalQuery: (definition) => internalQueryGeneric(definition),
    PublicMutation: (definition) => mutationGeneric(definition),
    InternalMutation: (definition) => internalMutationGeneric(definition),
    PublicAction: (definition) => actionGeneric(definition),
    InternalAction: (definition) => internalActionGeneric(definition),
    Registered: ({ handler }) => handler,
  });

/**
 * Convex evicts a query from its cache once the execution observes the current
 * time (every `Date.now()` read is tracked). Effect's logging, span, and
 * elapsed-time machinery reads timestamps through the ambient `Clock`'s unsafe
 * accessors, which would silently opt any logging or timing query out of the
 * cache—and there is no untracked time source in the isolate to serve them
 * from, since Effect's own live clock falls back to `Date.now()` for monotonic
 * time when neither `process.hrtime` nor `performance.now` exists. Queries
 * therefore run with a `Clock` whose unsafe accessors all return constants, so
 * logging and spans never touch the tracker and `Effect.timed` and duration
 * metrics report a zero elapsed time, while the effectful accessors
 * (`Clock.currentTimeMillis`/`currentTimeNanos`/`monotonicTimeNanos`) read the
 * real time, making them an explicit opt-in to cache eviction. Raw `Date.now()`
 * calls in handler code likewise opt out honestly.
 */
const queryClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 0,
  currentTimeNanosUnsafe: () => 0n,
  monotonicTimeNanosUnsafe: () => 0n,
  // oxlint-disable-next-line effecttsgo/global-date-in-effect -- This access intentionally notifies Convex's query-cache tracker.
  currentTimeMillis: Effect.sync(() => Date.now()),
  // oxlint-disable-next-line effecttsgo/global-date-in-effect -- This access intentionally notifies Convex's query-cache tracker.
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  // oxlint-disable-next-line effecttsgo/global-date-in-effect -- This access intentionally notifies Convex's query-cache tracker.
  monotonicTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  // `Effect.sleep` resolves the ambient clock, so it cannot be used here—it
  // would recurse straight back into this `sleep`.
  sleep: (duration) =>
    Effect.callback<void>((resume) => {
      // oxlint-disable-next-line effecttsgo/global-timers-in-effect -- Effect.sleep would resolve this Clock and recurse.
      const handle = setTimeout(
        () => resume(Effect.void),
        Duration.toMillis(duration),
      );
      return Effect.sync(() => clearTimeout(handle));
    }),
};

const queryFunction = <
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
  Args,
  ConvexArgs extends DefaultFunctionArgs,
  Returns,
  ConvexReturns,
  E,
>({
  databaseSchema,
  name,
  functionVisibility,
  args,
  returns,
  error,
  handler,
  resolvedMiddlewares,
  observability,
}: {
  databaseSchema: DatabaseSchema_;
  name: string;
  functionVisibility: FunctionVisibility;
  args: Schema.Codec<Args, ConvexArgs>;
  returns: Schema.Codec<Returns, ConvexReturns>;
  error: Schema.Codec<Error, Value> | undefined;
  handler: (
    a: Args,
  ) => Effect.Effect<Returns, E, Handler.QueryServices<DatabaseSchema_>>;
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>;
  observability?: Layer.Layer<never> | undefined;
}) => ({
  args: compileArgsSchema(args, databaseSchema.target.scope),
  returns: compileReturnsSchema(returns, databaseSchema.target.scope),
  handler: (
    ctx: GenericQueryCtx<
      DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>
    >,
    actualArgs: ConvexArgs,
  ): Promise<ConvexReturns> =>
    Effect.gen(function* () {
      const decodedArgs = yield* pipe(
        actualArgs,
        Schema.decodeUnknownEffect(args),
        Effect.catchTag("SchemaError", Effect.die),
      );
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Middleware errors are intentionally erased here and validated by runHandlerPromise against the combined error schema below.
      const decodedReturns = yield* RegisteredFunction.applyMiddleware(
        handler(decodedArgs),
        resolvedMiddlewares,
        {
          name,
          functionType: "query",
          functionVisibility,
          args: decodedArgs,
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            DatabaseReader.layer(databaseSchema, ctx.db),
            ExecutionMetadata.layer(ctx.meta),
            TransactionMetadata.layer(ctx.meta),
            QueryTransactionContext.layer(ctx),
            Auth.layerForTarget<DatabaseSchema_["target"]>(
              databaseSchema.target,
              ctx.auth,
            ),
            RegisteredFunction.storageLayer<
              DatabaseSchema.Scope<DatabaseSchema_>
            >(ctx.storage),
            QueryRunner.layer(ctx.runQuery),
            QueryCtx.layer<
              DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>,
              DatabaseSchema.Scope<DatabaseSchema_>
            >(ctx, databaseSchema.target.scope),
            ConvexConfigProvider.layer,
          ),
        ),
      );
      return yield* pipe(
        decodedReturns,
        Schema.encodeEffect(returns),
        Effect.catchTag("SchemaError", Effect.die),
      );
    }).pipe(
      RegisteredFunction.runHandlerPromise(
        RegisteredFunction.combineErrorSchemas(error, resolvedMiddlewares),
        {
          scheduler: new EffectScheduler.MixedScheduler("sync"),
          invocation: Effect.promise(() => ctx.meta.getFunctionMetadata()),
          clock: queryClock,
          observability,
        },
      ),
    ),
});

export const mutationLayer = <Schema extends DatabaseSchema.AnyWithProps>(
  schema: Schema,
  ctx: GenericMutationCtx<DataModel.ToConvex<DataModel.FromSchema<Schema>>>,
) =>
  Layer.mergeAll(
    DatabaseReader.layer(schema, ctx.db),
    DatabaseWriter.layer(schema, ctx.db),
    ExecutionMetadata.layer(ctx.meta),
    RequestMetadata.layer(ctx.meta),
    TransactionMetadata.layer(ctx.meta),
    Auth.layerForTarget<Schema["target"]>(schema.target, ctx.auth),
    Auth.mutationLayer(ctx.auth),
    Scheduler.layer<DatabaseSchema.Scope<Schema>>(
      ctx.scheduler,
      schema.target.scope,
    ),
    RegisteredFunction.storageLayer<DatabaseSchema.Scope<Schema>>(ctx.storage),
    StorageWriter.layer<DatabaseSchema.Scope<Schema>>(
      ctx.storage,
      schema.target.scope,
    ),
    QueryRunner.layer(ctx.runQuery),
    MutationRunner.layer(ctx.runMutation),
    QueryTransactionContext.layer(ctx),
    MutationTransactionContext.layer(ctx),
    MutationCtx.layer<
      DataModel.ToConvex<DataModel.FromSchema<Schema>>,
      DatabaseSchema.Scope<Schema>
    >(ctx, schema.target.scope),
    ConvexConfigProvider.layer,
  );

export type MutationServices<Schema extends DatabaseSchema.AnyWithProps> =
  Handler.MutationServices<Schema>;

const mutationFunction = <
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
  Args,
  ConvexArgs extends DefaultFunctionArgs,
  Returns,
  ConvexReturns,
  E,
>({
  databaseSchema,
  name,
  functionVisibility,
  args,
  returns,
  error,
  handler,
  resolvedMiddlewares,
  observability,
}: {
  databaseSchema: DatabaseSchema_;
  name: string;
  functionVisibility: FunctionVisibility;
  args: Schema.Codec<Args, ConvexArgs>;
  returns: Schema.Codec<Returns, ConvexReturns>;
  error: Schema.Codec<Error, Value> | undefined;
  handler: (
    a: Args,
  ) => Effect.Effect<Returns, E, MutationServices<DatabaseSchema_>>;
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>;
  observability?: Layer.Layer<never> | undefined;
}) => ({
  args: compileArgsSchema(args, databaseSchema.target.scope),
  returns: compileReturnsSchema(returns, databaseSchema.target.scope),
  handler: (
    ctx: GenericMutationCtx<
      DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>
    >,
    actualArgs: ConvexArgs,
  ): Promise<ConvexReturns> =>
    Effect.gen(function* () {
      const decodedArgs = yield* pipe(
        actualArgs,
        Schema.decodeUnknownEffect(args),
        Effect.catchTag("SchemaError", Effect.die),
      );
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Middleware errors are intentionally erased here and validated by runHandlerPromise against the combined error schema below.
      const decodedReturns = yield* RegisteredFunction.applyMiddleware(
        handler(decodedArgs),
        resolvedMiddlewares,
        {
          name,
          functionType: "mutation",
          functionVisibility,
          args: decodedArgs,
        },
      ).pipe(Effect.provide(mutationLayer(databaseSchema, ctx)));
      return yield* pipe(
        decodedReturns,
        Schema.encodeEffect(returns),
        Effect.catchTag("SchemaError", Effect.die),
      );
    }).pipe(
      RegisteredFunction.runHandlerPromise(
        RegisteredFunction.combineErrorSchemas(error, resolvedMiddlewares),
        {
          scheduler: new EffectScheduler.MixedScheduler("sync"),
          invocation: Effect.promise(() => ctx.meta.getFunctionMetadata()),
          observability,
        },
      ),
    ),
});

const convexActionFunction = <
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
  Args,
  ConvexArgs extends DefaultFunctionArgs,
  Returns,
  ConvexReturns,
  E,
>(
  schema: DatabaseSchema_,
  {
    name,
    functionVisibility,
    args,
    returns,
    error,
    handler,
    resolvedMiddlewares,
    observability,
  }: {
    name: string;
    functionVisibility: FunctionVisibility;
    args: Schema.Codec<Args, ConvexArgs>;
    returns: Schema.Codec<Returns, ConvexReturns>;
    error: Schema.Codec<any, any> | undefined;
    handler: (
      a: Args,
    ) => Effect.Effect<
      Returns,
      E,
      RegisteredFunction.ActionServices<DatabaseSchema_>
    >;
    resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>;
    observability?: Layer.Layer<never> | undefined;
  },
) =>
  RegisteredFunction.actionFunctionBase({
    scope: schema.target.scope,
    name,
    functionVisibility,
    args,
    returns,
    error,
    handler,
    resolvedMiddlewares,
    observability,
    createLayer: (ctx) =>
      Layer.mergeAll(
        RegisteredFunction.actionLayer(schema, ctx),
        ConvexConfigProvider.layer,
      ),
  });
