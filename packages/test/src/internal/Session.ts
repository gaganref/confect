import type { DatabaseSchema, DataModel } from "@confect/server";
import { RegisteredConvexFunction } from "@confect/server";
import { Ref } from "@confect/core";
import type {
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
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  ComponentKit,
  LayerOptions,
  RegisterComponent,
  TestConfect,
  TestConfectWithoutIdentity,
} from "../TestConfect.js";
import { convexTest as kernelTest } from "./ConvexTest.js";
import * as DriverWorld from "./DriverWorld.js";
import type * as Execution from "./Execution.js";
import { markAllFileRead } from "./FileSources.js";
import * as MountedHttp from "./MountedHttp.js";
import * as PushPreflight from "./PushPreflight.js";
import * as Redaction from "./Redaction.js";

declare const process: { env: Record<string, string | undefined> };

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
    private registerLater: (
      ...args: Parameters<RegisterComponent>
    ) => Effect.Effect<void>,
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
        Effect.suspend(() =>
          this.registerLater(componentPath, schema, modules, options),
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

class InvalidComponentKit extends Schema.TaggedError<
  InvalidComponentKit,
  { readonly brand: unique symbol }
>()("InvalidComponentKit", {
  componentPath: Schema.String,
  message: Schema.String,
}) {}

export const registerKit = (
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
      // A kit of schema and modules is the generated registry's, whose
      // sources it read from the module files.
      kit.sources === undefined && kit.databaseSchema === undefined
        ? undefined
        : {
            ...(kit.sources === undefined
              ? {}
              : { sources: markAllFileRead(kit.sources) }),
            ...(kit.databaseSchema === undefined
              ? {}
              : { databaseSchema: kit.databaseSchema }),
          },
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
 * The `"convex-test"` target's options. convex-test ignores `world`, the module
 * sources and the component runtimes, but the fork's kernel lane aliases
 * `convex-test` to the kernel, which draws a signing key or a cron delay from
 * the backend's own world and reads each module's runtime from its source.
 * Giving it the layer's seeded world and sources keeps one backend setup on
 * both lanes.
 */
const convexTestOptions = (
  schema: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options: LayerOptions,
): Parameters<typeof convexTest>[0] => {
  const withWorld = {
    schema,
    modules,
    world: DriverWorld.make("TestConfect.layer", options.seed ?? 0),
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    ...(options.componentRuntimes === undefined
      ? {}
      : { componentRuntimes: options.componentRuntimes }),
  };
  return withWorld;
};

/**
 * `register`, with the generated registry's sources for each component a kit
 * registers without its own. The layer leaves out a component whose runtime the
 * test declares, so that runtime takes their place, as it would for a kit that
 * gave none.
 */
const withComponentSources =
  (register: RegisterComponent, options: LayerOptions): RegisterComponent =>
  (componentPath, schema, modules, registered) =>
    register(
      componentPath,
      schema,
      modules,
      sourcedOptions(componentPath, registered, options),
    );

/**
 * `registered`, with the generated registry's sources for `componentPath` when
 * the kit gave none.
 */
const sourcedOptions = (
  componentPath: string,
  registered: Parameters<RegisterComponent>[3],
  options: LayerOptions,
): Parameters<RegisterComponent>[3] => {
  const sources =
    registered?.sources !== undefined
      ? undefined
      : options.componentSources?.[componentPath];
  return sources === undefined ? registered : { ...registered, sources };
};

/**
 * A backend that can stage a component, made but not yet registered, so its
 * source is checked before any call can reach it: the test kernel.
 */
/**
 * The backend calls a session refuses once a later registration's verification
 * refused: every function, HTTP request and scheduled run a test reaches it
 * by.
 */
const refusable: ReadonlySet<PropertyKey> = new Set([
  "query",
  "mutation",
  "action",
  "run",
  "runInComponent",
  "fetch",
  "jwks",
  "finishInProgressScheduledFunctions",
  "finishAllScheduledFunctions",
  "advance",
]);

/**
 * A component the test kernel staged: its own load, its mounted router's, and
 * its registration.
 */
interface Staged {
  readonly load: () => Promise<ReadonlyArray<unknown>>;
  readonly loadOutside: (
    modulePath: string,
    load: () => Promise<unknown>,
  ) => Promise<unknown>;
  readonly install: () => unknown;
}

const isStaging = (
  raw: unknown,
): raw is {
  readonly stage: (...args: Parameters<RegisterComponent>) => Staged;
} =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as { stage?: unknown }).stage === "function";

/**
 * Open one backend: the convex-test world or the kernel shim the target names,
 * with every kit the options register. `raw` is the backend the service runs
 * on, for a caller that must reach a component path.
 */
export const open = <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexSchemaDefinition: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options: LayerOptions = {},
  sink?: Execution.Sink,
): {
  readonly service: TestConfect<DatabaseSchema_>;
  readonly raw: any;
  readonly targets: ReadonlyArray<PushPreflight.Target>;
} => {
  process.env.CONVEX_CLOUD_URL ??= "https://some-deployment.convex.cloud";
  process.env.CONVEX_SITE_URL ??= "https://some.convex.site";
  // On the kernel, a value under a secret node of the app's table schemas, or
  // of the policy's functions and component tables, reaches every artifact as
  // a marker. The backend's own world draws from the seeded stream.
  const testConvex =
    options.target === "kernel"
      ? kernelTest({
          schema: convexSchemaDefinition,
          modules,
          world: DriverWorld.make("TestConfect.layer", options.seed ?? 0),
          ...(sink === undefined ? {} : { sink }),
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
      : convexTest(convexTestOptions(convexSchemaDefinition, modules, options));
  // convex-test takes three arguments and ignores the options. The kernel
  // reads `standing`, and a packaged kit's registration gains the sources
  // codegen read from its package.
  const register = withComponentSources(
    testConvex.registerComponent as unknown as RegisterComponent,
    options,
  );
  // Each component as it reaches the backend, the target its push checks run
  // for. A mounted component's HTTP module stays out, as the backend leaves
  // it out, since its router is built at its mount.
  const registered: Array<PushPreflight.Target> = [];
  const registerComponent: RegisterComponent = (
    componentPath,
    schema,
    componentModules,
    registerOptions,
  ) => {
    register(componentPath, schema, componentModules, registerOptions);
    registered.push({
      componentPath,
      modules: componentModules,
      schema: registerOptions?.databaseSchema,
    });
  };
  // On the kernel, a mounted component's router loads under the component's
  // load rules, as its modules do.
  const loadOutside: MountedHttp.LoadOutside | undefined =
    typeof (testConvex as { loadOutside?: unknown }).loadOutside === "function"
      ? (componentPath, modulePath, load) =>
          (testConvex as { loadOutside: MountedHttp.LoadOutside }).loadOutside(
            componentPath,
            modulePath,
            load,
          )
      : undefined;
  const mountedHttp = MountedHttp.make(
    options.httpMounts ?? [],
    (...args) => registerComponent(...args),
    loadOutside,
  );
  options.register?.(mountedHttp.register);
  // The app and each component a kit registered as the backend opened are the
  // targets its push checks run for, in registration order.
  // A mounted component's router is built at its mount, outside the
  // backend's own load, so the targets read it there, before any call.
  const withRouters = (
    components: ReadonlyArray<PushPreflight.Target>,
  ): ReadonlyArray<PushPreflight.Target> =>
    Arr.map(components, (component) => {
      const router = mountedHttp.httpModule(component.componentPath);
      return router === undefined
        ? component
        : { ...component, outside: [router] };
    });
  const targets: ReadonlyArray<PushPreflight.Target> = [
    { componentPath: "", modules, schema: databaseSchema },
    ...withRouters(registered),
  ];
  // A refused verification of a later registration refuses the whole session:
  // every call after it dies with that refusal, until one passes.
  let refusedBy: unknown;
  const gated = (accessor: any): any =>
    new Proxy(accessor, {
      get: (target, name, receiver) => {
        const value = Reflect.get(target, name, receiver);
        if (name === "withIdentity")
          return (...args: Array<unknown>) =>
            gated(
              (value as (...args: Array<unknown>) => unknown).apply(
                target,
                args,
              ),
            );
        if (typeof value !== "function" || !refusable.has(name)) return value;
        return (...args: Array<unknown>) =>
          refusedBy === undefined
            ? (value as (...args: Array<unknown>) => unknown).apply(
                target,
                args,
              )
            : Promise.reject(refusedBy);
      },
    });
  return {
    service: new TestConfectImpl(
      databaseSchema,
      gated(testConvex),
      mountedHttp,
      // A component the test registers later runs its checks before the
      // backend registers it, so a refused one is never callable and serves no
      // route. The targets registered before own what their entries run.
      (componentPath, schema, componentModules, registerOptions) => {
        if (options.pushChecks === "skip")
          return Effect.sync(() =>
            mountedHttp.register(
              componentPath,
              schema,
              componentModules,
              registerOptions,
            ),
          );
        // On the kernel, the component loads staged, under the kernel's load
        // rules, its mounted router against the staged component too, and the
        // registration adopts those loads.
        let staged: Staged | undefined;
        const prepared = mountedHttp.prepare(
          componentPath,
          schema,
          componentModules,
          registerOptions,
          isStaging(testConvex)
            ? (_path, modulePath, load) => staged!.loadOutside(modulePath, load)
            : undefined,
        );
        if (isStaging(testConvex))
          staged = testConvex.stage(
            componentPath,
            schema,
            prepared.modules,
            sourcedOptions(componentPath, prepared.options, options),
          );
        const target: PushPreflight.Target = {
          componentPath,
          modules: prepared.modules,
          schema: registerOptions?.databaseSchema,
          ...(prepared.httpModule === undefined
            ? {}
            : { outside: [prepared.httpModule] }),
          ...(staged === undefined ? {} : { load: staged.load }),
        };
        const stagedAt = staged;
        // Every target's checks run again, so a check the new component's
        // modules registered for another target's schema runs too.
        return PushPreflight.run(
          testConvex,
          [
            { componentPath: "", modules, schema: databaseSchema },
            ...withRouters(registered),
            target,
          ],
          options.pushChecks,
        ).pipe(
          Effect.tapError((refusal) =>
            Effect.sync(() => {
              refusedBy = refusal;
            }),
          ),
          Effect.orDie,
          Effect.andThen(
            Effect.sync(() => {
              refusedBy = undefined;
            }),
          ),
          Effect.andThen(
            Effect.sync(() =>
              prepared.install((path, installedSchema, installed, given) => {
                if (stagedAt === undefined)
                  register(path, installedSchema, installed, given);
                else stagedAt.install();
                registered.push({
                  componentPath: path,
                  modules: installed,
                  schema: given?.databaseSchema,
                });
              }),
            ),
          ),
        );
      },
    ),
    raw: testConvex,
    targets,
  };
};
