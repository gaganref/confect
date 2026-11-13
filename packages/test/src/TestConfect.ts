import { App, type Mount, Ref } from "@confect/core";
import type { DatabaseSchema, DataModel } from "@confect/server";
import { RegisteredConvexFunction } from "@confect/server";
import type {
  DeploymentJwks,
  TestConvexForDataModel,
  TestConvexForDataModelAndIdentity,
} from "convex-test";
import { convexTest } from "convex-test";
import type {
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
import * as Clock from "./internal/Clock.js";
import { convexTest as kernelTest } from "./internal/ConvexTest.js";
import type * as Invocation from "./internal/Invocation.js";
import * as MountedHttp from "./internal/MountedHttp.js";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Rec from "effect/Record";
import * as Redaction from "./internal/Redaction.js";

declare const process: { env: Record<string, string | undefined> };

/**
 * How a kit registers a component beyond its schema and modules.
 */
export type RegisterOptions = {
  /**
   * The component's functions, as `module:export`, that schedule their own next
   * run, such as the crons component's `public:rescheduler`. The test kernel
   * never treats a job that runs one, or that one schedules, as work
   * `finishAllScheduledFunctions` must finish. convex-test ignores it.
   */
  readonly standing?: ReadonlyArray<string>;
  /**
   * The component's module sources, such as `import.meta.glob(pattern, { query:
   * "?raw", import: "default" })` of the same files gives from any test file:
   * each matches its module by its path below the directory that holds
   * `_generated`. The test kernel reads each module's `"use node"` directive
   * from them, as Convex's bundler does. convex-test ignores it.
   */
  readonly sources?: Record<string, () => Promise<string>>;
};

/**
 * Register a component's Convex schema and modules at its installation path.
 */
export type RegisterComponent = (
  componentPath: string,
  schema: SchemaDefinition<GenericSchema, boolean>,
  modules: Record<string, () => Promise<any>>,
  options?: RegisterOptions,
) => void;

/**
 * An installed component path and the HTTP prefix exposed by its host.
 */
export type HttpMount = {
  readonly componentPath: string;
  readonly httpPrefix: string;
};

/**
 * The in-process backend a test layer runs on.
 */
export type Target = "convex-test" | "kernel";

export type TargetOptions = {
  /**
   * `"kernel"` runs every function and component the layer registers on
   * Confect's test kernel, which runs scheduled functions on its own clock and
   * reads `registerComponent`'s `standing`. Defaults to `"convex-test"`. The
   * option goes once the kernel replaces convex-test.
   */
  readonly target?: Target;
  /**
   * The seed of the random stream the `"kernel"` target's backend draws from on
   * its own, such as the random delay Convex gives each run of an hourly,
   * daily, weekly, monthly or cron-expression job. Two layers with the same
   * seed draw the same stream. Defaults to `0`. convex-test ignores it.
   */
  readonly seed?: number;
};

/**
 * Which values a kernel-target layer treats as secret, by component path, then
 * table name or `module:export`: each entry a thunk of the Confect schema whose
 * `Schema.Redacted` nodes mark the secrets. A value under one reaches the
 * kernel's artifacts (snapshots, failure reports, diffs) only as a marker. The
 * layer derives the app's own tables from its database schema, so this adds
 * function arguments and returns and component tables. Codegen fills it from
 * the Confect specs as `secrets` in the generated registry, which replaces a
 * hand-written one.
 */
export type SecretPolicy = {
  readonly tables?: Readonly<
    Record<string, Readonly<Record<string, () => Schema.Top>>>
  >;
  readonly functions?: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          {
            readonly args?: () => Schema.Top;
            readonly returns?: () => Schema.Top;
          }
        >
      >
    >
  >;
};

export type SourceOptions = {
  /**
   * The modules' sources, such as `import.meta.glob(pattern, { query: "?raw",
   * import: "default" })` of the same files gives from any test file: each
   * matches its module by its path below the directory that holds `_generated`.
   * The test kernel reads from them whether each module has a `"use node"`
   * directive, as Convex's bundler does. Without them the kernel takes a
   * Confect action's runtime from its registration, and refuses when it opens
   * with `ActionRuntimeUnknown` if a module exports a plain Convex action.
   * convex-test ignores it.
   */
  readonly sources?: Record<string, () => Promise<string>>;
  /**
   * The runtime each listed component's plain Convex actions run in, by
   * component path, for a component registered without sources, as a package's
   * test kit registers its modules: such as `{ "workflow/workpool": "isolate"
   * }`. A component registered with sources takes each module's runtime from
   * its directive instead. convex-test ignores it.
   */
  readonly componentRuntimes?: ComponentRuntimes;
};

/**
 * The runtime of each listed component's plain Convex actions, by component
 * path.
 */
export type ComponentRuntimes = Readonly<Record<string, "isolate" | "node">>;

export type LayerOptions = TargetOptions &
  SourceOptions & {
    /**
     * Register component kits synchronously before the test service is
     * available.
     */
    readonly register?: (registerComponent: RegisterComponent) => void;
    /**
     * Explicit HTTP mounts. The test layer does not evaluate convex.config.ts.
     */
    readonly httpMounts?: ReadonlyArray<HttpMount>;
    /**
     * The secret policy, read by the kernel target only.
     */
    readonly secrets?: SecretPolicy;
  };

export type { DeploymentJwk, DeploymentJwks } from "convex-test";

export type TestConfectWithoutIdentity<
  ConfectSchema extends DatabaseSchema.AnyWithProps,
> = {
  jwks: () => Effect.Effect<DeploymentJwks>;
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
    options?: RegisterOptions,
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

  readonly jwks = Effect.fn("TestConfect.jwks")(() =>
    Effect.promise(() => this.testConvex.jwks()),
  );

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
      (componentPath, schema, modules, options) =>
        Effect.sync(() =>
          this.mountedHttp.register(componentPath, schema, modules, options),
        ),
    );

  readonly jwks = () => this.testConfectImplWithoutIdentity.jwks();

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
 * How a test registers one installed component: its own schema and modules, or
 * the `register(t, name)` a component package exports from `<package>/testing`
 * or `<package>/test`, which also registers the package's own children.
 */
export type ComponentKit =
  | {
      readonly schema: SchemaDefinition<GenericSchema, boolean>;
      readonly modules: Record<string, () => Promise<any>>;
      /**
       * The component's module sources, as {@link RegisterOptions}'s.
       */
      readonly sources?: Record<string, () => Promise<string>>;
    }
  | {
      register(
        t: { readonly registerComponent: RegisterComponent },
        name: string,
      ): unknown;
    };

class InvalidComponentKit extends Schema.TaggedError<
  InvalidComponentKit,
  { readonly brand: unique symbol }
>()("InvalidComponentKit", {
  componentPath: Schema.String,
  message: Schema.String,
}) {}

const registerKit = (
  registerComponent: RegisterComponent,
  name: string,
  kit: ComponentKit,
) => {
  if ("register" in kit) {
    kit.register({ registerComponent }, name);
  } else if ("schema" in kit && "modules" in kit) {
    registerComponent(
      name,
      kit.schema,
      kit.modules,
      kit.sources === undefined ? undefined : { sources: kit.sources },
    );
  } else {
    // Codegen accepts a kit whose exports it cannot list, such as CommonJS.
    throw InvalidComponentKit.make({
      componentPath: name,
      // oxlint-disable-next-line effecttsgo/global-json -- Quotes the mount name in an error this sync registration throws; a string always serializes.
      message: `The test kit for ${JSON.stringify(name)} must export register(t, name), or schema and modules.`,
    });
  }
};

/**
 * Codegen's test-only schema and module registry.
 */
export type Registry<DatabaseSchema_ extends DatabaseSchema.AnyWithProps> = {
  readonly schema: DatabaseSchema_;
  readonly convexSchema: SchemaDefinition<GenericSchema, true>;
  readonly modules: Record<string, () => Promise<any>>;
  readonly components: Readonly<Record<string, ComponentKit>>;
  /**
   * The secret policy codegen derives from the Confect specs, read by the
   * kernel target only.
   */
  readonly secrets?: SecretPolicy;
  /**
   * The modules' sources and the package mounts' runtimes, as
   * {@link SourceOptions}'s. Build-order row 8's generated test subject supplies
   * them, the runtimes from each kit's metadata, and a layer's own options take
   * their place.
   */
  readonly sources?: Record<string, () => Promise<string>>;
  readonly componentRuntimes?: ComponentRuntimes;
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
 * Pass `{ target: "kernel" }` to run it on Confect's test kernel instead of
 * convex-test, with the modules' `sources` beside it.
 */
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  app: DeclaredApp<DatabaseSchema_>,
  options?: TargetOptions & SourceOptions,
): Layer.Layer<TestConfect<DatabaseSchema_>>;
export function layer<
  A extends App.Any,
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
>(
  app: A,
  registry: Registry<DatabaseSchema_> & {
    readonly components: Readonly<
      Record<
        Mount.NameOf<NoInfer<A>["mounts"][number]>,
        Registry<DatabaseSchema_>["components"][string]
      >
    >;
  },
  options?: TargetOptions & SourceOptions,
): Layer.Layer<TestConfect<DatabaseSchema_>>;
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexSchemaDefinition: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options?: LayerOptions,
): Layer.Layer<TestConfect<DatabaseSchema_>>;
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  appOrSchema: App.Any | DeclaredApp<DatabaseSchema_> | DatabaseSchema_,
  second?:
    | Registry<DatabaseSchema_>
    | SchemaDefinition<GenericSchema, true>
    | (TargetOptions & SourceOptions),
  third?: Record<string, () => Promise<any>> | (TargetOptions & SourceOptions),
  options: LayerOptions = {},
): Layer.Layer<TestConfect<DatabaseSchema_>> {
  if (App.isApp(appOrSchema)) {
    const registry = second as Registry<DatabaseSchema_>;
    const mounts = App.mounts(appOrSchema);
    return schemaLayer(
      registry.schema,
      registry.convexSchema,
      registry.modules,
      {
        ...targetOf(third as TargetOptions | undefined),
        ...secretsOf(registry),
        ...sourcesOf(registry, third as SourceOptions | undefined),
        // reduce skips a sparse list's holes, which effect/Array's flatMap visits.
        httpMounts: Array.reduce(
          mounts,
          Array.empty<{ componentPath: string; httpPrefix: string }>(),
          (httpMounts, { name, httpPrefix }) =>
            httpPrefix === undefined
              ? httpMounts
              : Array.append(httpMounts, { componentPath: name, httpPrefix }),
        ),
        register: (registerComponent) => {
          for (const [name, component] of Rec.toEntries(registry.components)) {
            if (
              Array.some(
                mounts,
                (mount) =>
                  name === mount.name ||
                  pipe(name, String.startsWith(`${mount.name}/`)),
              )
            ) {
              registerKit(registerComponent, name, component);
            }
          }
        },
      },
    );
  }
  if ("httpMounts" in appOrSchema) {
    const app = appOrSchema as DeclaredApp<DatabaseSchema_>;
    return schemaLayer(app.schema, app.convexSchema, app.modules, {
      ...targetOf(second as TargetOptions | undefined),
      ...secretsOf(app),
      ...sourcesOf(app, second as SourceOptions | undefined),
      httpMounts: app.httpMounts,
      register: (registerComponent) => {
        for (const [name, component] of Rec.toEntries(app.components)) {
          registerKit(registerComponent, name, component);
        }
      },
    });
  }
  return schemaLayer(
    appOrSchema as DatabaseSchema_,
    second as SchemaDefinition<GenericSchema, true>,
    third as Record<string, () => Promise<any>>,
    options,
  );
}

const targetOf = (options: TargetOptions | undefined): TargetOptions => ({
  ...(options?.target === undefined ? {} : { target: options.target }),
  ...(options?.seed === undefined ? {} : { seed: options.seed }),
});

/**
 * Mulberry32: a stream uniform on [0, 1) from a 32-bit seed. The kernel holds
 * no generator, so this driver supplies the stream, of the type a test world
 * gives its handlers.
 */
const seeded = (seed: number): (() => number) => {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/**
 * The world a kernel-target layer gives its backend: no services of its own,
 * the host's clock, which the kernel's clock follows, and a seeded stream.
 */
const layerWorld = (seed: number): Invocation.World => ({
  name: "TestConfect.layer",
  services: Context.empty(),
  clock: Clock.hostNow,
  random: seeded(seed),
});

const secretsOf = (registry: {
  readonly secrets?: SecretPolicy;
}): Pick<LayerOptions, "secrets"> =>
  registry.secrets === undefined ? {} : { secrets: registry.secrets };

const sourcesOf = (
  registry: SourceOptions,
  options: SourceOptions | undefined,
): SourceOptions => {
  const sources = options?.sources ?? registry.sources;
  const componentRuntimes =
    options?.componentRuntimes ?? registry.componentRuntimes;
  return {
    ...(sources === undefined ? {} : { sources }),
    ...(componentRuntimes === undefined ? {} : { componentRuntimes }),
  };
};

const schemaLayer = <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexSchemaDefinition: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options: LayerOptions = {},
): Layer.Layer<TestConfect<DatabaseSchema_>> =>
  Layer.sync(TestConfect<DatabaseSchema_>(), () => {
    process.env.CONVEX_CLOUD_URL ??= "https://some-deployment.convex.cloud";
    process.env.CONVEX_SITE_URL ??= "https://some.convex.site";
    // On the kernel, a value under a secret node of the app's table schemas,
    // or of the policy's functions and component tables, reaches every
    // artifact as a marker. The backend's own world draws from the seeded
    // stream.
    const testConvex =
      options.target === "kernel"
        ? kernelTest({
            schema: convexSchemaDefinition,
            modules,
            world: layerWorld(options.seed ?? 0),
            redaction: Redaction.policy(
              Redaction.merge(
                { tables: { "": Redaction.tablesOf(databaseSchema) } },
                options.secrets ?? {},
              ),
            ),
            ...(options.sources === undefined
              ? {}
              : { sources: options.sources }),
            ...(options.componentRuntimes === undefined
              ? {}
              : { componentRuntimes: options.componentRuntimes }),
          })
        : convexTest(convexSchemaDefinition, modules);
    // convex-test takes three arguments and ignores the options. The kernel
    // reads `standing`.
    const registerComponent =
      testConvex.registerComponent as unknown as RegisterComponent;
    const mountedHttp = MountedHttp.make(options.httpMounts ?? [], (...args) =>
      registerComponent(...args),
    );
    options.register?.(mountedHttp.register);
    return new TestConfectImpl(databaseSchema, testConvex as any, mountedHttp);
  });
