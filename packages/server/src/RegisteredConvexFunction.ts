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
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectScheduler from "effect/Scheduler";
import * as Auth from "./Auth.js";
import * as PushCheck from "./PushCheck.js";
import * as SecretSides from "./internal/secretSides.js";
import { markActionRuntime } from "./internal/actionRuntime.js";
import * as Hook from "./internal/definitionHook.js";
import * as ConvexConfigProvider from "./ConvexConfigProvider.js";
import * as DatabaseReader from "./DatabaseReader.js";
import * as DocumentIds from "./DocumentIds.js";
import * as DatabaseSchema from "./DatabaseSchema.js";
import * as DatabaseWriter from "./DatabaseWriter.js";
import type * as DataModel from "./DataModel.js";
import * as ExecutionMetadata from "./ExecutionMetadata.js";
import * as RequestMetadata from "./RequestMetadata.js";
import * as TransactionMetadata from "./TransactionMetadata.js";
import * as MutationCtx from "./MutationCtx.js";
import * as MutationAuth from "./MutationAuth.js";
import * as MutationRunner from "./MutationRunner.js";
import * as MutationTransactionContext from "./MutationTransactionContext.js";
import * as QueryCtx from "./QueryCtx.js";
import * as QueryRunner from "./QueryRunner.js";
import * as QueryTransactionContext from "./QueryTransactionContext.js";
import * as RegisteredFunction from "./RegisteredFunction.js";
import * as FunctionRegistryItem from "./FunctionRegistryItem.js";
import type * as ResolvedMiddleware from "./ResolvedMiddleware.js";
import * as Scheduler from "./Scheduler.js";
import { StorageActionWriter } from "./StorageActionWriter.js";
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

/**
 * The backend a prepared definition belongs to and its function's name, which
 * {@link register} guards the registered function with. Enumerable, so a
 * generated registration that spreads a definition to replace its handler keeps
 * it.
 *
 * A definition one loaded copy of `@confect/server` prepares may be registered
 * by another, so every copy reads it under this versioned key, as v1 defined
 * it: an object with the backend's database schema as `schema` and the
 * function's name as `name`. A change that cannot keep that meaning takes a new
 * versioned key.
 */
const preparedFor = Symbol.for(
  "@confect/server/RegisteredConvexFunction/preparedFor/v1",
);

interface PreparedFor {
  readonly schema: DatabaseSchema.AnyWithProps;
  readonly name: string;
}

/**
 * A definition carries push check metadata under the `preparedFor` key that is
 * not the v1 shape, so registering it would skip its backend's push checks.
 */
export class InvalidPreparedDefinition extends Schema.TaggedError<
  InvalidPreparedDefinition,
  { readonly brand: unique symbol }
>()("InvalidPreparedDefinition", {
  /**
   * The function's name, when the metadata names one.
   */
  functionName: Schema.optional(Schema.String),
  reason: Schema.String,
}) {
  override get message(): string {
    const subject =
      this.functionName === undefined
        ? "A prepared definition"
        : `The prepared definition of "${this.functionName}"`;
    return `${subject} carries invalid push check metadata (${this.reason}), so registering it would skip its backend's push checks`;
  }
}

/**
 * The backend and name a definition was prepared for: none for a definition
 * {@link prepare} never saw, or {@link InvalidPreparedDefinition} when its
 * metadata is present but not the v1 shape.
 */
const readPrepared = (
  definition: object,
): Result.Result<PreparedFor | undefined, InvalidPreparedDefinition> => {
  if (!(preparedFor in definition)) return Result.succeed(undefined);
  const target: unknown = (definition as { [preparedFor]: unknown })[
    preparedFor
  ];
  if (typeof target !== "object" || target === null)
    return Result.fail(
      InvalidPreparedDefinition.make({
        reason: `expected an object, got ${target === null ? "null" : typeof target}`,
      }),
    );
  const { schema, name } = target as {
    readonly schema?: unknown;
    readonly name?: unknown;
  };
  const functionName = typeof name === "string" ? { functionName: name } : {};
  if (!DatabaseSchema.isDatabaseSchema(schema))
    return Result.fail(
      InvalidPreparedDefinition.make({
        ...functionName,
        reason: "its schema is not a database schema",
      }),
    );
  if (typeof name !== "string")
    return Result.fail(
      InvalidPreparedDefinition.make({
        reason: "its name is not a string",
      }),
    );
  return Result.succeed({
    schema: schema as DatabaseSchema.AnyWithProps,
    name,
  });
};

export const prepare = (
  databaseSchema: DatabaseSchema.AnyWithProps,
  item: FunctionRegistryItem.ConfectFunctionRegistryItem,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware> = [],
  observability?: Layer.Layer<never>,
) =>
  Object.defineProperty(
    prepareFor(databaseSchema, item, resolvedMiddlewares, observability),
    preparedFor,
    {
      value: { schema: databaseSchema, name: item.name } satisfies PreparedFor,
      enumerable: true,
    },
  );

const prepareFor = (
  databaseSchema: DatabaseSchema.AnyWithProps,
  item: FunctionRegistryItem.ConfectFunctionRegistryItem,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware> = [],
  observability?: Layer.Layer<never>,
) => {
  const visibility = FunctionRegistryItem.convexVisibility(item);
  return Match.value(item.functionType).pipe(
    Match.when("query", () => {
      const definition = queryFunction({
        databaseSchema,
        name: item.name,
        reservedArgument: item.reservedArgument,
        observability,
        functionVisibility: visibility,
        args: item.args,
        returns: item.returns,
        error: item.error,
        handler: item.handler,
        resolvedMiddlewares,
      });
      return Match.value(visibility).pipe(
        Match.when("public", () => Definition.PublicQuery(definition)),
        Match.when("internal", () => Definition.InternalQuery(definition)),
        Match.exhaustive,
      );
    }),
    Match.when("mutation", () => {
      const definition = mutationFunction({
        databaseSchema,
        name: item.name,
        reservedArgument: item.reservedArgument,
        observability,
        functionVisibility: visibility,
        args: item.args,
        returns: item.returns,
        error: item.error,
        handler: item.handler,
        resolvedMiddlewares,
      });
      return Match.value(visibility).pipe(
        Match.when("public", () => Definition.PublicMutation(definition)),
        Match.when("internal", () => Definition.InternalMutation(definition)),
        Match.exhaustive,
      );
    }),
    Match.when("action", () => {
      const definition = convexActionFunction(databaseSchema, {
        name: item.name,
        reservedArgument: item.reservedArgument,
        observability,
        functionVisibility: visibility,
        args: item.args,
        returns: item.returns,
        error: item.error,
        handler: item.handler,
        resolvedMiddlewares,
      });
      return Match.value(visibility).pipe(
        Match.when("public", () => Definition.PublicAction(definition)),
        Match.when("internal", () => Definition.InternalAction(definition)),
        Match.exhaustive,
      );
    }),
    Match.exhaustive,
  );
};

export const make = (
  databaseSchema: DatabaseSchema.AnyWithProps,
  item: FunctionRegistryItem.ConfectFunctionRegistryItem,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware> = [],
): RegisteredFunction.Any =>
  register(prepare(databaseSchema, item, resolvedMiddlewares));

/**
 * Register a prepared definition with Convex. A definition {@link prepare}d for
 * a backend gets an `exportArgs` that first runs the push checks registered for
 * that backend's database schema, as `PushCheck` describes. A `Registered`
 * definition's handler is the one its builder guarded. A definition whose push
 * check metadata is present but malformed throws
 * {@link InvalidPreparedDefinition} rather than register without its checks.
 */
export const register = (self: Definition): RegisteredFunction.Any => {
  const prepared = readPrepared(self);
  if (Result.isFailure(prepared)) throw prepared.failure;
  const registered = registerUnguarded(self);
  return prepared.success === undefined
    ? registered
    : PushCheck.guardMade(
        registered,
        prepared.success.schema,
        prepared.success.name,
      );
};

/**
 * Bind a hook that receives each Convex definition this copy of
 * `@confect/server` registers, with the function's visibility, and returns the
 * definition Convex registers in its place. It sees every query, mutation and
 * action {@link register} registers from a prepared definition, and every Node
 * action `RegisteredNodeFunction` registers. It never sees a `Registered`
 * definition, which wraps a function Convex already registered. With no hook
 * bound, Confect registers each definition unchanged.
 *
 * A hook binds once, before any function registers, so it sees every
 * definition: bind it from a module every function module imports first, such
 * as the file of a manifest section that sets `importedFirst`. A second bind,
 * with any hook, throws {@link DefinitionHookRefused} with reason
 * `AlreadyBound`, and a bind after a function has registered throws it with
 * reason `FunctionRegistered`, because that function registered without the
 * hook.
 *
 * The definition's `args` and `returns` are lazy getters, and reading either
 * compiles the function's schemas, which every function otherwise does only
 * when Convex reads its validators. A hook keeps that laziness by defining its
 * own `args` and `returns` as getters. A hook that throws stops the module
 * registering the function from loading.
 */
export const bindDefinitionHook = (hook: Hook.DefinitionHook): void => {
  const bound = Hook.bind(hook);
  if (Result.isFailure(bound)) throw bound.failure;
};

export {
  type ConvexDefinition,
  type DefinitionHook,
  DefinitionHookRefused,
} from "./internal/definitionHook.js";

const hooked = (
  visibility: "public" | "internal",
  definition: Parameters<typeof RegisteredFunction.toConvexDefinition>[0] & {
    readonly handler: Hook.ConvexDefinition["handler"];
  },
) => Hook.apply(visibility, RegisteredFunction.toConvexDefinition(definition));

const registerUnguarded = (self: Definition): RegisteredFunction.Any =>
  Definition.$match(self, {
    PublicQuery: (definition) => queryGeneric(hooked("public", definition)),
    InternalQuery: (definition) =>
      internalQueryGeneric(hooked("internal", definition)),
    PublicMutation: (definition) =>
      mutationGeneric(hooked("public", definition)),
    InternalMutation: (definition) =>
      internalMutationGeneric(hooked("internal", definition)),
    PublicAction: (definition) =>
      markActionRuntime(actionGeneric(hooked("public", definition)), false),
    InternalAction: (definition) =>
      markActionRuntime(
        internalActionGeneric(hooked("internal", definition)),
        false,
      ),
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
  reservedArgument,
}: {
  databaseSchema: DatabaseSchema_;
  name: string;
  reservedArgument?: string | undefined;
  functionVisibility: FunctionVisibility;
  args: Schema.Codec<Args, ConvexArgs>;
  returns: Schema.Codec<Returns, ConvexReturns>;
  error: Schema.Codec<Error, Value> | undefined;
  handler: (
    a: Args,
  ) => Effect.Effect<Returns, E, Handler.QueryServices<DatabaseSchema_>>;
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>;
  observability?: Layer.Layer<never> | undefined;
}) =>
  SecretSides.define(
    {
      name,
      args,
      returns,
      scope: databaseSchema.target.scope,
      reservedArgument,
      lookups: (ctx) => SecretSides.databaseLookups(ctx.db),
    },
    (
      ctx: GenericQueryCtx<
        DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>
      >,
      actualArgs: ConvexArgs,
      failures: SecretSides.SchemaFailures,
    ): Promise<ConvexReturns> =>
      Effect.gen(function* () {
        const decodedArgs = yield* pipe(
          RegisteredFunction.domainArgs(actualArgs, reservedArgument),
          Schema.decodeUnknownEffect(args),
          Effect.catchTag("SchemaError", failures.args),
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
          Effect.provide([
            DatabaseReader.layer(databaseSchema, ctx.db),
            DocumentIds.layer(databaseSchema, ctx.db),
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
          ]),
        );
        return yield* pipe(
          decodedReturns,
          Schema.encodeEffect(returns),
          Effect.catchTag("SchemaError", failures.returns),
        );
      }).pipe(
        Effect.provideService(Clock.Clock, queryClock),
        RegisteredFunction.runHandlerPromise(
          RegisteredFunction.combineErrorSchemas(error, resolvedMiddlewares),
          {
            scheduler: new EffectScheduler.MixedScheduler("sync"),
            invocation: RegisteredFunction.invocationMetadata(
              ctx.meta,
              actualArgs,
              reservedArgument,
            ),
            clock: observability === undefined ? undefined : queryClock,
            observability,
            meta: ctx.meta,
            functionType: "query",
          },
        ),
      ),
  );

export const mutationLayer = <Schema extends DatabaseSchema.AnyWithProps>(
  schema: Schema,
  ctx: GenericMutationCtx<DataModel.ToConvex<DataModel.FromSchema<Schema>>>,
) =>
  Layer.mergeAll(
    DatabaseReader.layer(schema, ctx.db),
    DocumentIds.layer(schema, ctx.db),
    DatabaseWriter.layer(schema, ctx.db),
    ExecutionMetadata.layer(ctx.meta),
    RequestMetadata.layer(ctx.meta),
    TransactionMetadata.layer(ctx.meta),
    Auth.layerForTarget<Schema["target"]>(schema.target, ctx.auth),
    MutationAuth.layer(ctx.auth),
    Scheduler.layer<DatabaseSchema.Scope<Schema>>(
      ctx.scheduler,
      schema.target.scope,
    ),
    RegisteredFunction.storageLayer<DatabaseSchema.Scope<Schema>>(ctx.storage),
    StorageWriter.layer<DatabaseSchema.Scope<Schema>>(
      ctx.storage,
      schema.target.scope,
    ),
    StorageActionWriter.layer<DatabaseSchema.Scope<Schema>>(
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
  reservedArgument,
}: {
  databaseSchema: DatabaseSchema_;
  name: string;
  reservedArgument?: string | undefined;
  functionVisibility: FunctionVisibility;
  args: Schema.Codec<Args, ConvexArgs>;
  returns: Schema.Codec<Returns, ConvexReturns>;
  error: Schema.Codec<Error, Value> | undefined;
  handler: (
    a: Args,
  ) => Effect.Effect<Returns, E, MutationServices<DatabaseSchema_>>;
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>;
  observability?: Layer.Layer<never> | undefined;
}) =>
  SecretSides.define(
    {
      name,
      args,
      returns,
      scope: databaseSchema.target.scope,
      reservedArgument,
      lookups: (ctx) => SecretSides.databaseLookups(ctx.db),
    },
    (
      ctx: GenericMutationCtx<
        DataModel.ToConvex<DataModel.FromSchema<DatabaseSchema_>>
      >,
      actualArgs: ConvexArgs,
      failures: SecretSides.SchemaFailures,
    ): Promise<ConvexReturns> =>
      Effect.gen(function* () {
        const decodedArgs = yield* pipe(
          RegisteredFunction.domainArgs(actualArgs, reservedArgument),
          Schema.decodeUnknownEffect(args),
          Effect.catchTag("SchemaError", failures.args),
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
          // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Convex entry point provides invocation-local services before runHandlerPromise executes the handler.
        ).pipe(Effect.provide(mutationLayer(databaseSchema, ctx)));
        return yield* pipe(
          decodedReturns,
          Schema.encodeEffect(returns),
          Effect.catchTag("SchemaError", failures.returns),
        );
      }).pipe(
        RegisteredFunction.runHandlerPromise(
          RegisteredFunction.combineErrorSchemas(error, resolvedMiddlewares),
          {
            scheduler: new EffectScheduler.MixedScheduler("sync"),
            invocation: RegisteredFunction.invocationMetadata(
              ctx.meta,
              actualArgs,
              reservedArgument,
            ),
            observability,
            meta: ctx.meta,
            functionType: "mutation",
          },
        ),
      ),
  );

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
    reservedArgument,
  }: {
    name: string;
    reservedArgument?: string | undefined;
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
    reservedArgument,
    createLayer: (ctx) =>
      Layer.mergeAll(
        RegisteredFunction.actionLayer(schema, ctx),
        ConvexConfigProvider.layer,
      ),
  });
