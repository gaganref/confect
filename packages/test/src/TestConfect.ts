import { App, type Mount, type Ref } from "@confect/core";
import type { DatabaseSchema, RegisteredConvexFunction } from "@confect/server";
import type { DeploymentJwks } from "convex-test";
import type {
  GenericSchema,
  SchemaDefinition,
  UserIdentity,
} from "convex/server";
import type { Value } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Rec from "effect/Record";
import * as FileSources from "./internal/FileSources.js";
import * as PackagedSources from "./internal/PackagedSources.js";
import * as PushPreflight from "./internal/PushPreflight.js";
import * as Session from "./internal/Session.js";

export {
  PackagedComponentChanged,
  PackagedLayoutUnsupported,
  type PackageRead,
  type PackagedRefusal,
  type PackagedSources,
  type UnsupportedLayout,
  type UnsupportedPackage,
} from "./internal/PackagedSources.js";

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
   * The component's secret policy, keyed from the component: `""` for its own
   * tables and functions, a child's name for a component it mounts. The test
   * kernel keys it at the path the kit registers the component at, so a
   * packaged Confect component keeps its secrets marked. convex-test ignores
   * it.
   */
  readonly secrets?: SecretPolicy;
  /**
   * The component's module sources, such as `import.meta.glob(pattern, { query:
   * "?raw", import: "default" })` of the same files gives from any test file:
   * each matches its module by its path below the directory that holds
   * `_generated`. The test kernel reads each module's `"use node"` directive
   * from them, as Convex's bundler does. convex-test ignores it.
   */
  readonly sources?: Record<string, () => Promise<string>>;
  /**
   * The component's Confect database schema, the default export of its
   * generated `confect/_generated/schema` module, or a loader of that module or
   * of the schema, for a kit whose modules the layer cannot trace. Without it
   * the layer finds a component's schemas from its own module loads: a schema a
   * module registers checks for while the component's load evaluates it, or a
   * module it imports first, is the component's, and stays with the loaded
   * module once it is cached. It does not see a registration made by a module
   * evaluated outside any build's load, such as one the test imported first or
   * one another target's load evaluated, nor by a module several components
   * share once the first loads it; such a kit gives its schema here. Either way
   * the layer refuses, with `NoPushEntry`, a component whose checks none of its
   * functions or routers runs. A loader is read after the component's modules
   * load, so it names the copy they evaluated. convex-test ignores it.
   */
  readonly databaseSchema?: ComponentSchema;
};

/**
 * A component's Confect database schema, or a loader of it or of the module
 * whose default export it is.
 */
export type ComponentSchema = object | (() => Promise<unknown>);

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
   * seed draw the same stream, and on the kernel the same deployment signing
   * key. Defaults to `0`. convex-test ignores it.
   */
  readonly seed?: number;
  /**
   * Whether building the layer runs the push checks registered for each target
   * it builds, the app and every component a kit registers. Defaults to
   * `"run"`: building a backend whose source a push would refuse dies with
   * `PushRefused`, or with `NoPushEntry` when checks are registered for the
   * app's schema, or a component's, but none of its functions or routers runs
   * them, as `Preflight.run` describes. A component the test registers once the
   * backend is built, with `registerComponent`, dies with
   * `LateRegistrationUnsupported`, and is not installed, when any check is
   * registered for the backend or the component's own load registers one. A
   * check its load registered stays registered, unverified, so every later call
   * on that session dies with the same error. `"skip"` builds it anyway, and
   * registers a later component as it always has, for a test that builds a
   * refused source on purpose, such as one that asserts a call's own refusal.
   */
  readonly pushChecks?: PushPreflight.Mode;
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
    /**
     * Each packaged mount's module sources, by component path, as the layer
     * read and checked them from the registry's
     * {@link Registry.packagedSources}.
     */
    readonly componentSources?: ComponentSources;
  };

/**
 * Each packaged component's module sources, by the path its kit registers it
 * at.
 */
export type ComponentSources = Readonly<
  Record<string, Record<string, () => Promise<string>>>
>;

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
      /**
       * The component's Confect database schema, as {@link RegisterOptions}'s.
       */
      readonly databaseSchema?: ComponentSchema;
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
  /**
   * A reader of each packaged mount's installed files, and those of each
   * component its definition mounts, by component path. Each layer build reads
   * them again and checks them against codegen's digests, failing
   * {@link PackagedComponentChanged} if any changed. A mount whose layout
   * codegen does not read is a record instead, and fails
   * {@link PackagedLayoutUnsupported} unless `componentRuntimes` declares it. A
   * package's test kit registers its modules without sources, so the kernel
   * adds these to the kit's registration at that path. A runtime in
   * `componentRuntimes` for the path takes their place, and that path is not
   * read.
   */
  readonly packagedSources?: PackagedSources.PackagedSources | undefined;
};

/**
 * A registry that says it has no packaged mount, as generated `testing.ts` does
 * with `packagedSources: undefined`. Only this shape builds a layer that cannot
 * fail {@link PackagedComponentChanged} or {@link PackagedLayoutUnsupported}; a
 * registry that leaves the key out, `Omit`-widened ones included, may hide a
 * packaged mount.
 */
export type WithoutPackagedSources = {
  readonly packagedSources: undefined;
};

/**
 * A registry for `A`, which registers a kit for each of its mounts.
 */
type AppRegistry<
  A extends App.Any,
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
> = Registry<DatabaseSchema_> & {
  readonly components: Readonly<
    Record<
      Mount.NameOf<NoInfer<A>["mounts"][number]>,
      Registry<DatabaseSchema_>["components"][string]
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
 * Pass `{ target: "kernel" }` to run it on Confect's test kernel instead of
 * convex-test, with the modules' `sources` beside it.
 *
 * Building it runs the push checks registered for the app and each component a
 * kit registers, before it serves any call, an HTTP request included. It dies
 * with `PushRefused` when a push would refuse the source, or with `NoPushEntry`
 * when checks are registered for the app's or a component's schema but none of
 * its functions or routers runs them. A component the test registers later,
 * once the backend is built, is refused with `LateRegistrationUnsupported`
 * where push checks are involved: declare it in a kit instead. Pass
 * `pushChecks: "skip"` to build a refused source on purpose.
 */
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  app: DeclaredApp<DatabaseSchema_> & WithoutPackagedSources,
  options?: TargetOptions & SourceOptions,
): Layer.Layer<TestConfect<DatabaseSchema_>>;
export function layer<DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  app: DeclaredApp<DatabaseSchema_>,
  options?: TargetOptions & SourceOptions,
): Layer.Layer<TestConfect<DatabaseSchema_>, PackagedSources.PackagedRefusal>;
export function layer<
  A extends App.Any,
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
>(
  app: A,
  registry: AppRegistry<A, DatabaseSchema_> & WithoutPackagedSources,
  options?: TargetOptions & SourceOptions,
): Layer.Layer<TestConfect<DatabaseSchema_>>;
export function layer<
  A extends App.Any,
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
>(
  app: A,
  registry: AppRegistry<A, DatabaseSchema_>,
  options?: TargetOptions & SourceOptions,
): Layer.Layer<TestConfect<DatabaseSchema_>, PackagedSources.PackagedRefusal>;
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
): Layer.Layer<TestConfect<DatabaseSchema_>, PackagedSources.PackagedRefusal> {
  if (App.isApp(appOrSchema)) {
    const registry = second as Registry<DatabaseSchema_>;
    const mounts = App.mounts(appOrSchema);
    const sources = sourcesOf(registry, third as SourceOptions | undefined);
    return packagedLayer(registry, sources, (componentSources) =>
      schemaLayer(registry.schema, registry.convexSchema, registry.modules, {
        ...targetOf(third as TargetOptions | undefined),
        ...secretsOf(registry),
        ...sources,
        ...componentSources,
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
              Session.registerKit(registerComponent, name, component);
            }
          }
        },
      }),
    );
  }
  if ("httpMounts" in appOrSchema) {
    const app = appOrSchema as DeclaredApp<DatabaseSchema_>;
    const sources = sourcesOf(app, second as SourceOptions | undefined);
    return packagedLayer(app, sources, (componentSources) =>
      schemaLayer(app.schema, app.convexSchema, app.modules, {
        ...targetOf(second as TargetOptions | undefined),
        ...secretsOf(app),
        ...sources,
        ...componentSources,
        httpMounts: app.httpMounts,
        register: (registerComponent) => {
          for (const [name, component] of Rec.toEntries(app.components)) {
            Session.registerKit(registerComponent, name, component);
          }
        },
      }),
    );
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
  ...(options?.pushChecks === undefined
    ? {}
    : { pushChecks: options.pushChecks }),
});

const secretsOf = (registry: {
  readonly secrets?: SecretPolicy;
}): Pick<LayerOptions, "secrets"> =>
  registry.secrets === undefined ? {} : { secrets: registry.secrets };

const sourcesOf = (
  registry: SourceOptions,
  options: SourceOptions | undefined,
): SourceOptions => {
  // The registry's sources are the generated registry's, read from the
  // module files; a layer's own are as the test passed them.
  const sources =
    options?.sources ??
    (registry.sources === undefined
      ? undefined
      : FileSources.markAllFileRead(registry.sources));
  const componentRuntimes =
    options?.componentRuntimes ?? registry.componentRuntimes;
  return {
    ...(sources === undefined ? {} : { sources }),
    ...(componentRuntimes === undefined ? {} : { componentRuntimes }),
  };
};

/**
 * The layer `make` builds from the registry's packaged sources, read and
 * checked again on each build of it.
 */
const packagedLayer = <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  registry: Pick<Registry<DatabaseSchema_>, "packagedSources">,
  sources: SourceOptions,
  make: (
    componentSources: Pick<LayerOptions, "componentSources">,
  ) => Layer.Layer<TestConfect<DatabaseSchema_>>,
): Layer.Layer<TestConfect<DatabaseSchema_>, PackagedSources.PackagedRefusal> =>
  Layer.unwrap(
    PackagedSources.validateAll(
      registry.packagedSources,
      sources.componentRuntimes,
    ).pipe(
      Effect.map((componentSources) =>
        make(componentSources === undefined ? {} : { componentSources }),
      ),
    ),
  );

const schemaLayer = <DatabaseSchema_ extends DatabaseSchema.AnyWithProps>(
  databaseSchema: DatabaseSchema_,
  convexSchemaDefinition: SchemaDefinition<GenericSchema, true>,
  modules: Record<string, () => Promise<any>>,
  options: LayerOptions = {},
): Layer.Layer<TestConfect<DatabaseSchema_>> =>
  Layer.effect(
    TestConfect<DatabaseSchema_>(),
    Effect.suspend(() => {
      const opened = Session.open(
        databaseSchema,
        convexSchemaDefinition,
        modules,
        options,
      );
      // Before the service exists, so no call of any kind, an HTTP request
      // included, reaches a source a push would refuse. A refused source is a
      // defect of the backend under test, as a refused push is of a
      // deployment.
      return PushPreflight.run(
        opened.raw,
        opened.targets,
        options.pushChecks,
      ).pipe(Effect.orDie, Effect.as(opened.service));
    }),
  );
