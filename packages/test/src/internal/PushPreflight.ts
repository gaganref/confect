import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as PushCheck from "@confect/server/PushCheck";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { authConfigModule, functionModules } from "./Execution.js";
import * as Provenance from "./Provenance.js";

/**
 * Push checks are registered for a backend whose modules hold no registered
 * function and no HTTP router, so no push would run them.
 *
 * @stability unstable
 */
export class NoPushEntry extends Schema.TaggedError<
  NoPushEntry,
  { readonly brand: unique symbol }
>()("NoPushEntry", {
  /**
   * The names of the checks no entry runs.
   */
  checks: Schema.NonEmptyArray(Schema.String),
  /**
   * The component whose checks no entry runs, by its path, or none for the app.
   */
  componentPath: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const owner =
      this.componentPath === undefined
        ? "this backend"
        : `the component "${this.componentPath}"`;
    return `Push checks ${Arr.join(
      Arr.map(this.checks, (name) => `"${name}"`),
      ", ",
    )} are registered for ${owner}, but none of its modules registers a function or an HTTP router, so no push runs them`;
  }
}

/**
 * Push checks were registered while the modules of more than one target of a
 * test backend loaded, so the backend cannot tell which target owns them, and
 * cannot refuse with {@link NoPushEntry} a target whose checks none of its
 * entries runs. Pass the component's schema as `databaseSchema` in
 * `registerComponent`'s options, or in its kit's `{ schema, modules }`.
 *
 * @stability unstable
 */
export class PushCheckUnattributed extends Schema.TaggedError<
  PushCheckUnattributed,
  { readonly brand: unique symbol }
>()("PushCheckUnattributed", {
  /**
   * The names of the checks no one target owns.
   */
  checks: Schema.NonEmptyArray(Schema.String),
  /**
   * One target whose load they were registered in, by its component path, or
   * none for the app.
   */
  componentPath: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const owner =
      this.componentPath === undefined
        ? "this backend's modules"
        : `the component "${this.componentPath}"'s modules`;
    return `Push checks ${Arr.join(
      Arr.map(this.checks, (name) => `"${name}"`),
      ", ",
    )} were registered while ${owner} and another target's loaded, so the test backend cannot tell which owns them. Pass the owning component's schema as databaseSchema, in registerComponent's options or its kit's { schema, modules }`;
  }
}

/**
 * A component registered once its test backend was built would take part in
 * push checks, its own or the backend's, which run only as the backend is
 * built. It is not installed. Declare it in the kit or subject the backend is
 * built from, so its checks run with the build's.
 *
 * When the component's own load registered a check, that check stays
 * registered, unverified, for the backend's schemas too, so the session fails
 * every function, HTTP action and scheduled job it runs from then on with this
 * error, `refusesSession` set, before any of their code runs.
 *
 * @stability unstable
 */
export class LateRegistrationUnsupported extends Schema.TaggedError<
  LateRegistrationUnsupported,
  { readonly brand: unique symbol }
>()("LateRegistrationUnsupported", {
  /**
   * The component registered late, by its path.
   */
  componentPath: Schema.String,
  /**
   * Whether the component's load registered a push check, so the session can no
   * longer be trusted and refuses every call.
   */
  refusesSession: Schema.optional(Schema.Boolean),
}) {
  override get message(): string {
    const refused = `The component "${this.componentPath}" was registered after its test backend was built, where push checks are registered, which run only as a backend is built. It was not installed.`;
    const declare = `Declare it in the kit or subject the backend is built from, so its checks run with the build's`;
    return this.refusesSession === true
      ? `${refused} Its load registered a push check no build verified, which stays registered, so this session can't be trusted: every function, HTTP action and scheduled job it runs from now on fails with this error. ${declare}`
      : `${refused} ${declare}`;
  }
}

/**
 * Where a target's database schema comes from: the schema itself, or a loader
 * of it or of the module whose default export it is, such as the generated
 * `confect/_generated/schema` module of one mount's copy of a component.
 */
export type SchemaSource = object | (() => Promise<unknown>);

/**
 * Whether a test backend runs its targets' push checks when it is built:
 * `"run"`, the default, or `"skip"`.
 */
export type Mode = "run" | "skip";

/**
 * One target's evaluated modules, and the database schema its checks are
 * registered under when the caller knows it.
 */
export interface Loaded {
  readonly modules: Iterable<unknown>;
  readonly schema?: object | undefined;
  /**
   * The component the modules belong to, which a {@link NoPushEntry} names, or
   * none for the app.
   */
  readonly componentPath?: string | undefined;
  /**
   * The schemas the modules' loads registered push checks for, which a
   * {@link NoPushEntry} refuses like `schema` when none of the modules runs
   * their checks.
   */
  readonly traced?: ReadonlyArray<object> | undefined;
  /**
   * The schemas registered while this target's load and another's both ran,
   * which a {@link PushCheckUnattributed} refuses.
   */
  readonly unattributed?: ReadonlyArray<object> | undefined;
  /**
   * Whether every module of the target loaded. A target whose load failed
   * somewhere refuses no {@link NoPushEntry}, since the module that failed may
   * hold its entry and fails the call that loads it, but its checks still run.
   */
  readonly complete?: boolean | undefined;
}

/**
 * The database schemas whose checks `modules`' functions and routers run.
 */
const entriesOf = (modules: Iterable<unknown>): Set<object> => {
  const found = new Set<object>();
  for (const loaded of modules) {
    if (typeof loaded !== "object" || loaded === null) continue;
    for (const value of Rec.values(loaded as Record<string, unknown>)) {
      const target = PushCheck.targetOf(value);
      if (target !== undefined) found.add(target);
    }
  }
  return found;
};

/**
 * The schemas `targets` own: each one's given schema and each schema its
 * entries, `entries` by target, run the checks of.
 */
const ownersOf = (
  targets: ReadonlyArray<Loaded>,
  entries: ReadonlyArray<ReadonlySet<object>>,
): Set<object> => {
  const owned = new Set<object>(Arr.flatMap(entries, (found) => [...found]));
  for (const { schema } of targets) if (schema !== undefined) owned.add(schema);
  return owned;
};

/**
 * Run, apart from the analysis memo, each check registered for a database
 * schema one of `targets`' functions or routers runs the checks of, once each
 * and in registration order, and refuse with the first refusal.
 *
 * Before that, a target refuses with {@link PushCheckUnattributed} when checks
 * were registered while its load and another target's both ran and no target of
 * its build owns them, which `unattributed` already leaves out, and with
 * {@link NoPushEntry} when checks are registered for its given schema, or for
 * one its own modules' loads registered, but none of its modules runs them. A
 * schema its loads registered that another target's entries run is that
 * target's, as a module one target loads first may register for another.
 *
 * @stability unstable
 */
export const verify = (
  targets: ReadonlyArray<Loaded>,
): Result.Result<
  void,
  PushCheck.PushRefused | NoPushEntry | PushCheckUnattributed
> => {
  const checks = new Set<Pick<PushCheck.PushCheck, "name" | "check">>();
  const entries = Arr.map(targets, (target) => entriesOf(target.modules));
  const run = new Set<object>(Arr.flatMap(entries, (found) => [...found]));
  for (const [index, target] of targets.entries()) {
    const { schema, componentPath, traced, unattributed, complete } = target;
    const found = entries[index]!;
    // `run` leaves out what its build, or a build it encloses, owns.
    const unowned = Arr.flatMap(unattributed ?? [], (each: object) =>
      PushCheck.registered(each),
    );
    if (Arr.isReadonlyArrayNonEmpty(unowned))
      return Result.fail(
        PushCheckUnattributed.make({
          checks: Arr.map(unowned, (check) => check.name),
          ...(componentPath === undefined ? {} : { componentPath }),
        }),
      );
    const owned = new Set<object>(
      Arr.filter(traced ?? [], (each) => !run.has(each)),
    );
    if (schema !== undefined) owned.add(schema);
    for (const each of complete === false ? [] : owned) {
      if (found.has(each)) continue;
      const unrun = PushCheck.registered(each);
      if (Arr.isReadonlyArrayNonEmpty(unrun))
        return Result.fail(
          NoPushEntry.make({
            checks: Arr.map(unrun, (check) => check.name),
            ...(componentPath === undefined ? {} : { componentPath }),
          }),
        );
    }
    // Every schema the target owns, its entries' and those its loads
    // registered for or it names, so a check a failed load registered runs.
    for (const each of [...found, ...owned])
      for (const check of PushCheck.registered(each)) checks.add(check);
  }
  for (const check of checks) {
    const verdict = PushCheck.verify(check);
    if (Result.isFailure(verdict)) return verdict;
  }
  return Result.succeed(undefined);
};

/**
 * Load each of `loads` in order, as loads of `owner`'s modules, keeping each
 * that loads. `complete` says whether every one loaded. A module that fails to
 * load fails the call that loads it, as it always has, and the checks it
 * registered before it failed still count for `owner`. A loader that throws
 * before it returns a promise rejects.
 */
const loadEach = (
  loads: ReadonlyArray<() => Promise<unknown>>,
  owner: object,
): Effect.Effect<{
  readonly modules: ReadonlyArray<unknown>;
  readonly complete: boolean;
}> =>
  Effect.map(
    Effect.forEach(loads, (load) =>
      Effect.promise(() =>
        Provenance.owning(owner, () =>
          Provenance.record(load).then(
            (value) => ({ value }),
            () => undefined,
          ),
        ),
      ),
    ),
    (loaded) => ({
      modules: Arr.flatMap(loaded, (each) =>
        each === undefined ? [] : [each.value],
      ),
      complete: Arr.every(loaded, (each) => each !== undefined),
    }),
  );

/**
 * The database schema `source` names: itself, or what its loader resolves to,
 * or that module's default export. `undefined` when the loader fails or names
 * no database schema.
 */
const schemaOf = (
  source: SchemaSource | undefined,
  owner: object,
): Effect.Effect<object | undefined> => {
  if (source === undefined) return Effect.undefined;
  if (typeof source !== "function") return Effect.succeed(source);
  return Effect.map(
    loadEach([source as () => Promise<unknown>], owner),
    ({ modules: [value] }) => {
      if (DatabaseSchema.isDatabaseSchema(value)) return value;
      const fallback = (value as { readonly default?: unknown } | undefined)
        ?.default;
      return DatabaseSchema.isDatabaseSchema(fallback) ? fallback : undefined;
    },
  );
};

/**
 * One target a test backend builds: the app at `""` or a component at its path,
 * the modules it was registered with, its database schema when known, and the
 * modules the backend builds outside its own load, such as a mounted
 * component's router, which the backend builds at its mount.
 */
export interface Target {
  readonly componentPath: string;
  readonly modules: Readonly<Record<string, () => Promise<unknown>>>;
  readonly schema?: SchemaSource | undefined;
  readonly outside?: ReadonlyArray<() => Promise<unknown>> | undefined;
  /**
   * The target's own load, in place of the backend's, for a component staged
   * but not yet registered: its modules' namespaces, or a rejection when they
   * fail to load.
   */
  readonly load?: (() => Promise<ReadonlyArray<unknown>>) | undefined;
  /**
   * The target's identity across loads of it, so the checks a failed load of
   * its modules registered still count when it is read again. The target itself
   * by default.
   */
  readonly owner?: object | undefined;
}

/**
 * Whether `raw`, the backend a session opened, is the test kernel, which loads
 * modules under its own guards and so must load them itself.
 */
const isKernel = (
  raw: unknown,
): raw is {
  readonly preload: (componentPath: string) => Promise<void>;
  readonly loadedModules: (componentPath: string) => ReadonlyArray<unknown>;
} =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as { preload?: unknown }).preload === "function" &&
  typeof (raw as { loadedModules?: unknown }).loadedModules === "function";

/**
 * The evaluated modules of `target` on `raw`: on the kernel, its own guarded
 * load, which its open reuses, and on convex-test, each module a deployment
 * registers as functions imported, which the test runtime does not evaluate
 * again, then the modules it builds outside its own load, as a mounted router.
 * A module that fails to load leaves the target incomplete, and the checks it
 * registered before it failed count for the target.
 */
const loadedOf = (raw: unknown, target: Target): Effect.Effect<Loaded> =>
  Effect.gen(function* () {
    const owner = ownerOf(target);
    let modules: ReadonlyArray<unknown>;
    let complete = true;
    if (target.load !== undefined) {
      const { load } = target;
      const loaded = yield* Effect.promise(() =>
        Provenance.owning(owner, () =>
          load().then(
            (namespaces) => namespaces,
            () => undefined,
          ),
        ),
      );
      complete = loaded !== undefined;
      modules = loaded ?? [];
    } else if (isKernel(raw)) {
      // The kernel's open fails every call with a failed load, as before.
      complete = yield* Effect.promise(() =>
        Provenance.owning(owner, () =>
          raw.preload(target.componentPath).then(
            () => true,
            () => false,
          ),
        ),
      );
      modules = raw.loadedModules(target.componentPath);
    } else {
      const loaders = functionModules(target.modules);
      const imported = yield* loadEach(
        Arr.map(
          Arr.sort(Rec.keys(loaders), Order.String),
          (path) => loaders[path]!,
        ),
        owner,
      );
      modules = imported.modules;
      complete = imported.complete;
    }
    // After the backend's own load, so a schema module its entries import is
    // the one they evaluated.
    const outside = yield* loadEach(target.outside ?? [], owner);
    const schema = yield* schemaOf(target.schema, owner);
    const all = [...modules, ...outside.modules];
    return {
      modules: all,
      schema,
      traced: [...Provenance.schemasOf(all), ...Provenance.failedOf(owner)],
      unattributed: Provenance.unattributedOf(owner),
      complete: complete && outside.complete,
      ...(target.componentPath === ""
        ? {}
        : { componentPath: target.componentPath }),
    };
  });

/**
 * Whether `raw` is the test kernel, which loads the app's `auth.config` once
 * under its own guards, after every component, and so must load it itself.
 */
const loadsAuthConfig = (
  raw: unknown,
): raw is { readonly preloadAuthConfig: () => Promise<unknown> } =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as { preloadAuthConfig?: unknown }).preloadAuthConfig ===
    "function";

/**
 * `loaded`, the app's target, with its `auth.config` module too, which a
 * backend loads beside the functions, the kernel once every component has
 * loaded. On the kernel it is the kernel's own load, which its open reuses. A
 * module that fails to load leaves the target incomplete, and fails what it
 * failed before, while the checks it registered before it failed count. Any
 * other target is as it was.
 */
const withAuthConfig = (
  raw: unknown,
  target: Target,
  loaded: Loaded,
): Effect.Effect<Loaded> => {
  if (target.componentPath !== "" || target.load !== undefined)
    return Effect.succeed(loaded);
  const owner = ownerOf(target);
  const authConfig = authConfigModule(target.modules);
  const config: Effect.Effect<{
    readonly modules: ReadonlyArray<unknown>;
    readonly complete: boolean;
  }> = loadsAuthConfig(raw)
    ? Effect.promise(() =>
        Provenance.owning(owner, () =>
          raw.preloadAuthConfig().then(
            (module) => ({
              modules: module === undefined ? [] : [module],
              complete: true,
            }),
            () => ({ modules: [], complete: false }),
          ),
        ),
      )
    : loadEach(authConfig === undefined ? [] : [authConfig], owner);
  return Effect.map(config, ({ modules, complete }) => {
    const all = [...loaded.modules, ...modules];
    return {
      ...loaded,
      modules: all,
      traced: [...Provenance.schemasOf(all), ...Provenance.failedOf(owner)],
      unattributed: Provenance.unattributedOf(owner),
      complete: loaded.complete !== false && complete,
    };
  });
};

/**
 * The identity a target's loads and attributions are kept under.
 */
const ownerOf = (target: Target): object => target.owner ?? target;

/**
 * Run the push checks of each target a test backend builds, before it serves a
 * call: each check registered for a target, once per run and apart from the
 * analysis memo, failing with the first {@link PushCheck.PushRefused}, or with
 * {@link NoPushEntry} for a target whose schema has checks none of its modules
 * runs. With `"skip"` it runs nothing.
 *
 * @stability unstable
 */
export const run = (
  raw: unknown,
  targets: ReadonlyArray<Target>,
  mode: Mode = "run",
): Effect.Effect<
  void,
  PushCheck.PushRefused | NoPushEntry | PushCheckUnattributed
> =>
  mode === "skip"
    ? Effect.void
    : Effect.gen(function* () {
        // Inside the build whose load runs this one, if any.
        yield* Effect.sync(() =>
          Provenance.beginBuild(Arr.map(targets, ownerOf)),
        );
        const loaded: Array<readonly [Target, Loaded]> = [];
        for (const target of targets) {
          const modules = yield* loadedOf(raw, target);
          loaded.push([target, modules]);
        }
        // Then the app's `auth.config`, as a backend loads it after every
        // component, before any call.
        for (const [index, [target, modules]] of loaded.entries())
          loaded[index] = [target, yield* withAuthConfig(raw, target, modules)];
        // A schema this build owns is no longer unattributable for it, nor for
        // a build whose load encloses it.
        const owners = ownersOf(
          Arr.map(loaded, ([, each]) => each),
          Arr.map(loaded, ([, each]) => entriesOf(each.modules)),
        );
        for (const target of targets)
          for (const each of Provenance.unattributedOf(ownerOf(target)))
            if (owners.has(each)) Provenance.resolve(ownerOf(target), each);
        yield* Effect.fromResult(
          verify(
            Arr.map(loaded, ([target, each]) => ({
              ...each,
              unattributed: Provenance.unattributedOf(ownerOf(target)),
            })),
          ),
        );
      });

/**
 * Whether a schema has any push check registered for it.
 */
const hasChecks = (schema: object): boolean =>
  Arr.isReadonlyArrayNonEmpty(PushCheck.registered(schema));

/**
 * Whether any push check is registered for a schema one of `targets` owns: its
 * given schema, one its entries run the checks of, or one its loads registered
 * checks for, a failed load's too. It runs no check.
 */
export const involvesChecks = (
  raw: unknown,
  targets: ReadonlyArray<Target>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const target of targets) {
      const loaded = yield* loadedOf(raw, target);
      const { modules, traced, unattributed, schema } = yield* withAuthConfig(
        raw,
        target,
        loaded,
      );
      if (
        Arr.some(
          [
            ...entriesOf(modules),
            ...(traced ?? []),
            ...(unattributed ?? []),
            ...(schema === undefined ? [] : [schema]),
          ],
          hasChecks,
        )
      )
        return true;
    }
    return false;
  });
