import { App, Ref } from "@confect/core";
import type { DatabaseSchema, DataModel } from "@confect/server";
import { RegisteredConvexFunction } from "@confect/server";
import type {
  TestConvexForDataModel,
  TestConvexForDataModelAndIdentity,
} from "convex-test";
import { convexTest } from "convex-test";
import type {
  GenericDataModel,
  GenericMutationCtx,
  GenericSchema,
  SchemaDefinition,
  UserIdentity,
} from "convex/server";
import type { Value } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as MountedHttp from "./internal/MountedHttp";

/**
 * Register a component's Convex schema and modules at its installation path.
 */
export type RegisterComponent =
  TestConvexForDataModelAndIdentity<GenericDataModel>["registerComponent"];

/**
 * An installed component path and the HTTP prefix exposed by its host.
 */
export type HttpMount = {
  readonly componentPath: string;
  readonly httpPrefix: string;
};

export type LayerOptions = {
  /**
   * Register component kits synchronously before the test service is available.
   */
  readonly register?: (registerComponent: RegisterComponent) => void;
  /**
   * Explicit HTTP mounts. The test layer does not evaluate convex.config.ts.
   */
  readonly httpMounts?: ReadonlyArray<HttpMount>;
};

export type TestConfectWithoutIdentity<
  ConfectSchema extends DatabaseSchema.AnyWithProps,
> = {
  query: <QueryRef extends Ref.AnyQuery>(
    queryRef: QueryRef,
    ...args: Ref.OptionalArgs<QueryRef>
  ) => Effect.Effect<
    Ref.Returns<QueryRef>,
    Ref.Error<QueryRef> | Schema.SchemaError
  >;
  mutation: <MutationRef extends Ref.AnyMutation>(
    mutationRef: MutationRef,
    ...args: Ref.OptionalArgs<MutationRef>
  ) => Effect.Effect<
    Ref.Returns<MutationRef>,
    Ref.Error<MutationRef> | Schema.SchemaError
  >;
  action: <ActionRef extends Ref.AnyAction>(
    actionRef: ActionRef,
    ...args: Ref.OptionalArgs<ActionRef>
  ) => Effect.Effect<
    Ref.Returns<ActionRef>,
    Ref.Error<ActionRef> | Schema.SchemaError
  >;
  run: {
    <E>(
      handler: Effect.Effect<
        void,
        E,
        RegisteredConvexFunction.MutationServices<ConfectSchema>
      >,
    ): Effect.Effect<void>;
    <A, B extends Value, E>(
      handler: Effect.Effect<
        A,
        E,
        RegisteredConvexFunction.MutationServices<ConfectSchema>
      >,
      returns: Schema.Codec<A, B>,
    ): Effect.Effect<A, Schema.SchemaError>;
  };
  fetch: (
    pathQueryFragment: string,
    init?: RequestInit,
  ) => Effect.Effect<Response>;
  finishInProgressScheduledFunctions: () => Effect.Effect<void>;
  finishAllScheduledFunctions: (
    advanceTimers: () => void,
  ) => Effect.Effect<void>;
};

export type TestConfect<ConfectSchema extends DatabaseSchema.AnyWithProps> = {
  registerComponent: (
    componentPath: string,
    schema: SchemaDefinition<GenericSchema, boolean>,
    modules: Record<string, () => Promise<any>>,
  ) => Effect.Effect<void>;
  withIdentity: (
    userIdentity: Partial<UserIdentity>,
  ) => TestConfectWithoutIdentity<ConfectSchema>;
} & TestConfectWithoutIdentity<ConfectSchema>;

export const TestConfect = <
  ConfectSchema extends DatabaseSchema.AnyWithProps,
>() => Context.Service<TestConfect<ConfectSchema>>("@confect/test/TestConfect");

class TestConfectImplWithoutIdentity<
  ConfectSchema extends DatabaseSchema.AnyWithProps,
> implements TestConfectWithoutIdentity<ConfectSchema> {
  constructor(
    private confectSchema: ConfectSchema,
    private testConvex: TestConvexForDataModel<
      DataModel.ToConvex<DataModel.FromSchema<ConfectSchema>>
    >,
    private mountedHttp: ReturnType<typeof MountedHttp.make>,
  ) {}

  readonly query = <QueryRef extends Ref.AnyQuery>(
    queryRef: QueryRef,
    ...args: Ref.OptionalArgs<QueryRef>
  ): Effect.Effect<
    Ref.Returns<QueryRef>,
    Ref.Error<QueryRef> | Schema.SchemaError
  > =>
    Ref.runWithCodec(
      queryRef,
      (args[0] ?? {}) as Ref.Args<QueryRef>,
      (functionReference, encodedArgs) =>
        this.testConvex.query(functionReference as any, encodedArgs),
    );

  readonly mutation = <MutationRef extends Ref.AnyMutation>(
    mutationRef: MutationRef,
    ...args: Ref.OptionalArgs<MutationRef>
  ): Effect.Effect<
    Ref.Returns<MutationRef>,
    Ref.Error<MutationRef> | Schema.SchemaError
  > =>
    Ref.runWithCodec(
      mutationRef,
      (args[0] ?? {}) as Ref.Args<MutationRef>,
      (functionReference, encodedArgs) =>
        this.testConvex.mutation(functionReference as any, encodedArgs),
    );

  readonly action = <ActionRef extends Ref.AnyAction>(
    actionRef: ActionRef,
    ...args: Ref.OptionalArgs<ActionRef>
  ): Effect.Effect<
    Ref.Returns<ActionRef>,
    Ref.Error<ActionRef> | Schema.SchemaError
  > =>
    Ref.runWithCodec(
      actionRef,
      (args[0] ?? {}) as Ref.Args<ActionRef>,
      (functionReference, encodedArgs) =>
        this.testConvex.action(functionReference as any, encodedArgs),
    );

  readonly run: TestConfectWithoutIdentity<ConfectSchema>["run"] = (<
    A,
    B extends Value,
    E,
  >(
    handler: Effect.Effect<
      A,
      E,
      RegisteredConvexFunction.MutationServices<ConfectSchema>
    >,
    returns?: Schema.Codec<A, B>,
  ): Effect.Effect<void> | Effect.Effect<A, Schema.SchemaError> => {
    const makeMutationLayer = (
      mutationCtx: GenericMutationCtx<
        DataModel.ToConvex<DataModel.FromSchema<ConfectSchema>>
      >,
    ): Layer.Layer<RegisteredConvexFunction.MutationServices<ConfectSchema>> =>
      RegisteredConvexFunction.mutationLayer(
        this.confectSchema,
        mutationCtx,
      ) as Layer.Layer<
        RegisteredConvexFunction.MutationServices<ConfectSchema>
      >;

    return returns === undefined
      ? Effect.promise(() =>
          this.testConvex.run((mutationCtx) =>
            Effect.runPromise(
              handler.pipe(
                Effect.asVoid,
                Effect.provide(makeMutationLayer(mutationCtx)),
              ),
            ),
          ),
        )
      : Effect.promise(() =>
          this.testConvex.run((mutationCtx) =>
            Effect.runPromise(
              handler.pipe(
                Effect.andThen(Schema.encodeEffect(returns)),
                Effect.provide(makeMutationLayer(mutationCtx)),
              ),
            ),
          ),
        ).pipe(Effect.andThen(Schema.decodeEffect(returns)));
  }) as TestConfectWithoutIdentity<ConfectSchema>["run"];

  readonly fetch = <PathQueryFragment extends string>(
    pathQueryFragment: PathQueryFragment,
    init?: RequestInit,
  ) =>
    Effect.promise(() =>
      this.mountedHttp.fetch(this.testConvex, pathQueryFragment, init),
    );

  readonly finishInProgressScheduledFunctions = () =>
    Effect.promise(() => this.testConvex.finishInProgressScheduledFunctions());

  readonly finishAllScheduledFunctions = (advanceTimers: () => void) =>
    Effect.promise(() =>
      this.testConvex.finishAllScheduledFunctions(advanceTimers),
    );
}

class TestConfectImpl<
  ConfectSchema extends DatabaseSchema.AnyWithProps,
> implements TestConfect<ConfectSchema> {
  private readonly testConfectImplWithoutIdentity: TestConfectImplWithoutIdentity<ConfectSchema>;

  constructor(
    private confectSchema: ConfectSchema,
    private testConvex: TestConvexForDataModelAndIdentity<
      DataModel.ToConvex<DataModel.FromSchema<ConfectSchema>>
    >,
    private mountedHttp: ReturnType<typeof MountedHttp.make>,
  ) {
    this.testConfectImplWithoutIdentity = new TestConfectImplWithoutIdentity(
      confectSchema,
      testConvex,
      mountedHttp,
    );
  }

  readonly withIdentity = (userIdentity: Partial<UserIdentity>) =>
    new TestConfectImplWithoutIdentity(
      this.confectSchema,
      this.testConvex.withIdentity(userIdentity),
      this.mountedHttp,
    );

  readonly registerComponent: TestConfect<ConfectSchema>["registerComponent"] =
    Effect.fn("TestConfect.registerComponent")(
      (componentPath, schema, modules) =>
        Effect.sync(() =>
          this.mountedHttp.register(componentPath, schema, modules),
        ),
    );

  readonly query = <QueryRef extends Ref.AnyQuery>(
    queryRef: QueryRef,
    ...args: Ref.OptionalArgs<QueryRef>
  ) => this.testConfectImplWithoutIdentity.query(queryRef, ...args);

  readonly mutation = <MutationRef extends Ref.AnyMutation>(
    mutationRef: MutationRef,
    ...args: Ref.OptionalArgs<MutationRef>
  ) => this.testConfectImplWithoutIdentity.mutation(mutationRef, ...args);

  readonly action = <ActionRef extends Ref.AnyAction>(
    actionRef: ActionRef,
    ...args: Ref.OptionalArgs<ActionRef>
  ) => this.testConfectImplWithoutIdentity.action(actionRef, ...args);

  readonly run: TestConfect<ConfectSchema>["run"] = ((
    handler: any,
    returns?: any,
  ) =>
    this.testConfectImplWithoutIdentity.run(
      handler,
      returns,
    )) as TestConfect<ConfectSchema>["run"];

  readonly fetch = <PathQueryFragment extends string>(
    pathQueryFragment: PathQueryFragment,
    init?: RequestInit,
  ) => this.testConfectImplWithoutIdentity.fetch(pathQueryFragment, init);

  readonly finishInProgressScheduledFunctions = () =>
    this.testConfectImplWithoutIdentity.finishInProgressScheduledFunctions();

  readonly finishAllScheduledFunctions = (advanceTimers: () => void) =>
    this.testConfectImplWithoutIdentity.finishAllScheduledFunctions(
      advanceTimers,
    );
}

/**
 * Codegen's test-only schema and module registry.
 */
export type Registry<DatabaseSchema_ extends DatabaseSchema.AnyWithProps> = {
  readonly schema: DatabaseSchema_;
  readonly convexSchema: SchemaDefinition<GenericSchema, true>;
  readonly modules: Record<string, () => Promise<any>>;
  readonly components: Readonly<
    Record<
      string,
      {
        readonly schema: SchemaDefinition<GenericSchema, boolean>;
        readonly modules: Record<string, () => Promise<any>>;
      }
    >
  >;
};

/**
 * The declared app's generated, test-only representation.
 */
export type DeclaredApp<DatabaseSchema_ extends DatabaseSchema.AnyWithProps> =
  Registry<DatabaseSchema_> & {
    readonly httpMounts: ReadonlyArray<HttpMount>;
  };

/**
 * Build a fresh test backend from a declaration and its generated
 * `confect/_generated/testing` registry, without restating component mounts.
 */
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  app: DeclaredApp<DatabaseSchema_>,
): Layer.Layer<TestConfect<DatabaseSchema_>>;
export function layer<
  A extends App.Any,
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
>(
  app: A,
  registry: Registry<DatabaseSchema_> & {
    readonly components: Readonly<
      Record<
        keyof NoInfer<A>["mounts"],
        Registry<DatabaseSchema_>["components"][string]
      >
    >;
  },
): Layer.Layer<TestConfect<DatabaseSchema_>>;
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexSchemaDefinition: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options?: LayerOptions,
): Layer.Layer<TestConfect<DatabaseSchema_>>;
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  appOrSchema: App.Any | DeclaredApp<DatabaseSchema_> | DatabaseSchema_,
  registryOrSchema?:
    | Registry<DatabaseSchema_>
    | SchemaDefinition<GenericSchema, true>,
  modules?: Record<string, () => Promise<any>>,
  options: LayerOptions = {},
): Layer.Layer<TestConfect<DatabaseSchema_>> {
  if (App.isApp(appOrSchema)) {
    const registry = registryOrSchema as Registry<DatabaseSchema_>;
    const mounts = App.mounts(appOrSchema);
    return schemaLayer(
      registry.schema,
      registry.convexSchema,
      registry.modules,
      {
        httpMounts: mounts.flatMap(({ name, httpPrefix }) =>
          httpPrefix === undefined ? [] : [{ componentPath: name, httpPrefix }],
        ),
        register: (registerComponent) => {
          for (const [name, component] of Object.entries(registry.components)) {
            if (
              mounts.some(
                (mount) =>
                  name === mount.name || name.startsWith(`${mount.name}/`),
              )
            ) {
              registerComponent(name, component.schema, component.modules);
            }
          }
        },
      },
    );
  }
  if ("httpMounts" in appOrSchema) {
    const app = appOrSchema as DeclaredApp<DatabaseSchema_>;
    return schemaLayer(app.schema, app.convexSchema, app.modules, {
      httpMounts: app.httpMounts,
      register: (registerComponent) => {
        for (const [name, component] of Object.entries(app.components)) {
          registerComponent(name, component.schema, component.modules);
        }
      },
    });
  }
  return schemaLayer(
    appOrSchema as DatabaseSchema_,
    registryOrSchema as SchemaDefinition<GenericSchema, true>,
    modules!,
    options,
  );
}

const schemaLayer = <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexSchemaDefinition: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options: LayerOptions = {},
): Layer.Layer<TestConfect<DatabaseSchema_>> =>
  Layer.sync(TestConfect<DatabaseSchema_>(), () => {
    const testConvex = convexTest(convexSchemaDefinition, modules);
    const mountedHttp = MountedHttp.make(options.httpMounts ?? [], (...args) =>
      testConvex.registerComponent(...args),
    );
    options.register?.(mountedHttp.register);
    return new TestConfectImpl(databaseSchema, testConvex as any, mountedHttp);
  });
