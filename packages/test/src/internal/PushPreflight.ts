import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as PushCheck from "@confect/server/PushCheck";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { functionModules } from "./Execution.js";
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
    const { schema, componentPath, traced, unattributed } = target;
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
    for (const each of owned) {
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
    for (const each of found)
      for (const check of PushCheck.registered(each)) checks.add(check);
  }
  for (const check of checks) {
    const verdict = PushCheck.verify(check);
    if (Result.isFailure(verdict)) return verdict;
  }
  return Result.succeed(undefined);
};

/**
 * Run `load` and keep what it resolves to, or `undefined` when it throws or
 * rejects. A loader that throws before it returns a promise counts as one that
 * rejects.
 */
const attempt = (
  load: () => Promise<unknown>,
  owner?: object,
): Effect.Effect<{ readonly value: unknown } | undefined> =>
  Effect.promise(() => {
    const loading = () =>
      Provenance.record(load).then(
        (value) => ({ value }),
        () => undefined,
      );
    return owner === undefined ? loading() : Provenance.owning(owner, loading);
  });

/**
 * Import every loader of `loads` in order, as loads of `owner`'s modules,
 * keeping each that loads. `complete` says whether every one loaded.
 */
const importEach = (
  loads: ReadonlyArray<() => Promise<unknown>>,
  owner?: object,
): Effect.Effect<{
  readonly modules: ReadonlyArray<unknown>;
  readonly complete: boolean;
}> =>
  Effect.gen(function* () {
    const loaded: Array<unknown> = [];
    let complete = true;
    for (const load of loads) {
      const module = yield* attempt(load, owner);
      if (module === undefined) complete = false;
      else loaded.push(module.value);
    }
    return { modules: loaded, complete };
  });

/**
 * Import every loader of `loads` in order, as loads of `owner`'s modules, a
 * failure to load dying with that failure.
 */
const importStrictly = (
  loads: ReadonlyArray<() => Promise<unknown>>,
  owner: object,
): Effect.Effect<{
  readonly modules: ReadonlyArray<unknown>;
  readonly complete: boolean;
}> =>
  Effect.map(
    Effect.forEach(loads, (load) =>
      Effect.promise(() =>
        Provenance.owning(owner, () => Provenance.record(load)),
      ),
    ),
    (modules) => ({ modules, complete: true }),
  );

/**
 * Import every module of `modules` in path order, keeping each that loads.
 * `complete` says whether every one loaded.
 */
export const importAll = (
  modules: Readonly<Record<string, () => Promise<unknown>>>,
  owner?: object,
): Effect.Effect<{
  readonly modules: ReadonlyArray<unknown>;
  readonly complete: boolean;
}> =>
  importEach(
    Arr.map(
      Arr.sort(Rec.keys(modules), Order.String),
      (path) => modules[path]!,
    ),
    owner,
  );

/**
 * The database schema `source` names: itself, or what its loader resolves to,
 * or that module's default export. `undefined` when the loader fails or names
 * no database schema.
 */
const schemaOf = (
  source: SchemaSource | undefined,
): Effect.Effect<object | undefined> => {
  if (source === undefined) return Effect.undefined;
  if (typeof source !== "function") return Effect.succeed(source);
  return Effect.map(attempt(source as () => Promise<unknown>), (loaded) => {
    const value = loaded?.value;
    if (DatabaseSchema.isDatabaseSchema(value)) return value;
    const fallback = (value as { readonly default?: unknown } | undefined)
      ?.default;
    return DatabaseSchema.isDatabaseSchema(fallback) ? fallback : undefined;
  });
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
   * Whether a module outside the target's own load that fails to load fails the
   * run with its failure, as a component registered later refuses to install a
   * router that cannot load, rather than leave it to be loaded, unchecked, by
   * its first request.
   */
  readonly strict?: boolean | undefined;
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
 * again. A target whose kernel load fails runs no check, since its open fails
 * every call the same way. A module that fails to import is left out, and the
 * target's schema goes unchecked for {@link NoPushEntry}, since that module may
 * have held its entry. Either failure still reaches the call that loads the
 * module, as it did before.
 */
const loadedOf = (
  raw: unknown,
  target: Target,
): Effect.Effect<Loaded | undefined> =>
  Effect.gen(function* () {
    let modules: ReadonlyArray<unknown>;
    let complete: boolean;
    if (target.load !== undefined) {
      const { load } = target;
      const loaded = yield* Effect.promise(() =>
        Provenance.owning(target, () =>
          load().then(
            (namespaces) => ({ namespaces }),
            () => undefined,
          ),
        ),
      );
      if (loaded === undefined) return undefined;
      modules = loaded.namespaces;
      complete = true;
    } else if (isKernel(raw)) {
      const loaded = yield* Effect.promise(() =>
        Provenance.owning(target, () =>
          raw.preload(target.componentPath).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (!loaded) return undefined;
      modules = raw.loadedModules(target.componentPath);
      complete = true;
    } else {
      ({ modules, complete } = yield* importAll(
        functionModules(target.modules),
        target,
      ));
    }
    // After the backend's own load, so a schema module its entries import is
    // the one they evaluated.
    const outside =
      target.strict === true
        ? yield* importStrictly(target.outside ?? [], target)
        : yield* importEach(target.outside ?? [], target);
    const schema = yield* schemaOf(target.schema);
    const all = [...modules, ...outside.modules];
    const whole = complete && outside.complete;
    return {
      modules: all,
      schema: whole ? schema : undefined,
      traced: whole ? Provenance.schemasOf(all) : [],
      unattributed: Provenance.unattributedOf(target),
      ...(target.componentPath === ""
        ? {}
        : { componentPath: target.componentPath }),
    };
  });

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
        yield* Effect.sync(() => Provenance.beginBuild(targets));
        const loaded: Array<readonly [Target, Loaded]> = [];
        for (const target of targets) {
          const modules = yield* loadedOf(raw, target);
          if (modules !== undefined) loaded.push([target, modules]);
        }
        // A schema this build owns is no longer unattributable for it, nor for
        // a build whose load encloses it.
        const owners = ownersOf(
          Arr.map(loaded, ([, each]) => each),
          Arr.map(loaded, ([, each]) => entriesOf(each.modules)),
        );
        for (const target of targets)
          for (const each of Provenance.unattributedOf(target))
            if (owners.has(each)) Provenance.resolve(target, each);
        yield* Effect.fromResult(
          verify(
            Arr.map(loaded, ([target, each]) => ({
              ...each,
              unattributed: Provenance.unattributedOf(target),
            })),
          ),
        );
      });
