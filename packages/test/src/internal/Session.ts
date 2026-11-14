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
import * as Context from "effect/Context";
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
import * as Clock from "./Clock.js";
import { convexTest as kernelTest } from "./ConvexTest.js";
import type * as Execution from "./Execution.js";
import type * as Invocation from "./Invocation.js";
import * as MountedHttp from "./MountedHttp.js";
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
    registerComponent(name, kit.schema, kit.modules);
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

/**
 * The `"convex-test"` target's options. convex-test ignores `world`, but the
 * fork's kernel lane aliases `convex-test` to the kernel, which draws a signing
 * key or a cron delay from the backend's own world. Giving it the layer's
 * seeded world keeps one source of randomness on both lanes.
 */
const convexTestOptions = (
  schema: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options: LayerOptions,
): Parameters<typeof convexTest>[0] => {
  const withWorld = {
    schema,
    modules,
    world: layerWorld(options.seed ?? 0),
  };
  return withWorld;
};

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
): { readonly service: TestConfect<DatabaseSchema_>; readonly raw: any } => {
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
          world: layerWorld(options.seed ?? 0),
          ...(sink === undefined ? {} : { sink }),
          redaction: Redaction.policy(
            Redaction.merge(
              { tables: { "": Redaction.tablesOf(databaseSchema) } },
              options.secrets ?? {},
            ),
          ),
        })
      : convexTest(convexTestOptions(convexSchemaDefinition, modules, options));
  // convex-test takes three arguments and ignores the options. The kernel
  // reads `standing`.
  const registerComponent =
    testConvex.registerComponent as unknown as RegisterComponent;
  const mountedHttp = MountedHttp.make(options.httpMounts ?? [], (...args) =>
    registerComponent(...args),
  );
  options.register?.(mountedHttp.register);
  return {
    service: new TestConfectImpl(
      databaseSchema,
      testConvex as any,
      mountedHttp,
    ),
    raw: testConvex,
  };
};
