import { App, type Mount, type Ref } from "@confect/core";
import type { DatabaseSchema } from "@confect/server";
import type { RegisteredConvexFunction } from "@confect/server";
import type {
  GenericSchema,
  SchemaDefinition,
  UserIdentity,
} from "convex/server";
import type { Value } from "convex/values";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as Session from "./internal/Session.js";

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
};

export type LayerOptions = TargetOptions & {
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
    options?: RegisterOptions,
  ) => Effect.Effect<void>;
  withIdentity: (
    userIdentity: Partial<UserIdentity>,
  ) => TestConfectWithoutIdentity<ConfectSchema>;
} & TestConfectWithoutIdentity<ConfectSchema>;

export const TestConfect = <
  ConfectSchema extends DatabaseSchema.AnyWithProps,
>() => Context.Service<TestConfect<ConfectSchema>>("@confect/test/TestConfect");

/**
 * How a test registers one installed component: its own schema and modules, or
 * the `register(t, name)` a component package exports from `<package>/testing`
 * or `<package>/test`, which also registers the package's own children.
 */
export type ComponentKit =
  | {
      readonly schema: SchemaDefinition<GenericSchema, boolean>;
      readonly modules: Record<string, () => Promise<any>>;
    }
  | {
      register(
        t: { readonly registerComponent: RegisterComponent },
        name: string,
      ): unknown;
    };

/**
 * Codegen's test-only schema and module registry.
 */
export type Registry<DatabaseSchema_ extends DatabaseSchema.AnyWithProps> = {
  readonly schema: DatabaseSchema_;
  readonly convexSchema: SchemaDefinition<GenericSchema, true>;
  readonly modules: Record<string, () => Promise<any>>;
  readonly components: Readonly<Record<string, ComponentKit>>;
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
 * convex-test.
 */
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  app: DeclaredApp<DatabaseSchema_>,
  options?: TargetOptions,
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
  options?: TargetOptions,
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
    | TargetOptions,
  third?: Record<string, () => Promise<any>> | TargetOptions,
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
              Session.registerKit(registerComponent, name, component);
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
      httpMounts: app.httpMounts,
      register: (registerComponent) => {
        for (const [name, component] of Object.entries(app.components)) {
          Session.registerKit(registerComponent, name, component);
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

const targetOf = (options: TargetOptions | undefined): TargetOptions =>
  options?.target === undefined ? {} : { target: options.target };

const schemaLayer = <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexSchemaDefinition: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options: LayerOptions = {},
): Layer.Layer<TestConfect<DatabaseSchema_>> =>
  Layer.sync(
    TestConfect<DatabaseSchema_>(),
    () =>
      Session.open(databaseSchema, convexSchemaDefinition, modules, options)
        .service,
  );
