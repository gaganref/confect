import { AsyncLocalStorage } from "node:async_hooks";
import * as Arr from "effect/Array";

/**
 * Which database schemas a target's own module loads registered push checks
 * for, so a test backend can refuse, with `NoPushEntry`, a component whose
 * checks none of its entries runs. This detects a misconfigured kit. It is not
 * the guard: a guarded entry runs its checks at build and at push whether or
 * not this sees its registration.
 *
 * `@confect/server`'s `PushCheck.register` tells every observer in the set
 * under `Symbol.for("@confect/server/PushCheck/observers/v1")` of each schema
 * it registers a check for. While a module loads under {@link record}, the
 * observer adds that schema to the load's own set, which an async context
 * carries into the module's code and every module it imports first. The load's
 * namespace keeps those schemas, so a target that loads that same module again
 * once it is cached, as a later backend over one graph does, still names them.
 * A target that only reaches such a module through imports of its own modules
 * owns none of its schemas.
 */

const observersKey = Symbol.for("@confect/server/PushCheck/observers/v1");

/**
 * One load running: the schemas registered while it ran, the target it loads
 * for when that differs from the load around it, and that load.
 */
interface Scope {
  readonly schemas: Set<object>;
  readonly owner: object | undefined;
  readonly outer: Scope | undefined;
}

/**
 * The innermost load running now.
 */
const loading = new AsyncLocalStorage<Scope>();

/**
 * The target whose modules load now, as {@link owning} names it.
 */
const owners = new AsyncLocalStorage<object>();

/**
 * The schemas each module namespace's load registered checks for.
 */
const traced = new WeakMap<object, Set<object>>();

/**
 * The schemas the failed loads of each target's modules registered checks for.
 */
const failed = new WeakMap<object, Set<object>>();

/**
 * The schemas registered while loads of more than one target ran, kept for each
 * of those targets.
 */
const unattributed = new WeakMap<object, Set<object>>();

const observe = (schema: object) => {
  const scope = loading.getStore();
  if (scope === undefined) return;
  const seen = new Set<object>();
  for (let each: Scope | undefined = scope; each; each = each.outer)
    if (each.owner !== undefined) seen.add(each.owner);
  if (seen.size > 1) {
    for (const owner of seen) {
      const kept = unattributed.get(owner);
      if (kept === undefined) unattributed.set(owner, new Set([schema]));
      else kept.add(schema);
    }
    return;
  }
  scope.schemas.add(schema);
};

/**
 * Add this copy's observer to the process's set, once.
 */
const install = () => {
  const holder = globalThis as {
    [observersKey]?: Set<(schema: object) => void>;
  };
  (holder[observersKey] ??= new Set()).add(observe);
};

install();

const isNamespace = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/**
 * Run `run` as a load of `owner`'s modules. A registration made while one
 * target's load runs inside another's belongs to neither, and is kept for both
 * as unattributable.
 */
export const owning = <A>(owner: object, run: () => A): A =>
  owners.run(owner, run);

/**
 * Run `load`, a module loader, keeping the schemas its load registers checks
 * for on the namespace it resolves to. A nested load keeps its own and passes
 * them to the load around it, as a module's imports load inside its own. A
 * loader that throws before it returns a promise rejects.
 */
export const record = <A>(load: () => Promise<A>): Promise<A> => {
  const outer = loading.getStore();
  const owner = owners.getStore();
  const scope: Scope = {
    schemas: new Set(),
    owner,
    outer,
  };
  return loading
    .run(scope, () => Promise.resolve().then(load))
    .then(
      (namespace) => {
        const { schemas } = scope;
        if (isNamespace(namespace) && schemas.size > 0) {
          const kept = traced.get(namespace);
          if (kept === undefined) traced.set(namespace, schemas);
          else for (const schema of schemas) kept.add(schema);
        }
        if (outer !== undefined)
          for (const schema of schemas) outer.schemas.add(schema);
        return namespace;
      },
      (failure: unknown) => {
        // A load that fails still registered what it registered, and those
        // checks are its target's, with no namespace to keep them on.
        const { schemas } = scope;
        if (outer !== undefined)
          for (const schema of schemas) outer.schemas.add(schema);
        if (owner !== undefined && schemas.size > 0) {
          const kept = failed.get(owner);
          if (kept === undefined) failed.set(owner, new Set(schemas));
          else for (const schema of schemas) kept.add(schema);
        }
        throw failure;
      },
    );
};

/**
 * The schemas a failed load of `owner`'s modules registered checks for, which
 * count for it as a loaded module's do.
 */
export const failedOf = (owner: object): ReadonlyArray<object> => [
  ...(failed.get(owner) ?? []),
];

/**
 * The schemas the loads of `namespaces` registered checks for, in the order
 * they were first registered.
 */
export const schemasOf = (
  namespaces: Iterable<unknown>,
): ReadonlyArray<object> => {
  const found = new Set<object>();
  for (const namespace of namespaces) {
    if (!isNamespace(namespace)) continue;
    for (const schema of traced.get(namespace) ?? []) found.add(schema);
  }
  return [...found];
};

/**
 * One verification of a test backend's targets, and the build whose load ran
 * it, as a backend a module of another backend builds while it loads: the
 * schemas it, or a build it encloses, found an owner for.
 */
interface Build {
  readonly resolved: Set<object>;
  readonly parent: Build | undefined;
}

/**
 * The build each target is verified in.
 */
const builds = new WeakMap<object, Build>();

/**
 * Start a build of `targets`, inside the build whose target's load runs now, if
 * any.
 */
export const beginBuild = (targets: ReadonlyArray<object>): void => {
  const enclosing = owners.getStore();
  const build: Build = {
    resolved: new Set(),
    parent: enclosing === undefined ? undefined : builds.get(enclosing),
  };
  for (const target of targets) builds.set(target, build);
};

/**
 * Take `schema` as owned in `owner`'s build and every build that encloses it,
 * so none of those counts it as unattributable. An unrelated build still does.
 */
export const resolve = (owner: object, schema: object): void => {
  for (let build = builds.get(owner); build; build = build.parent)
    build.resolved.add(schema);
};

/**
 * The schemas registered while `owner`'s load and another target's both ran,
 * which neither can be said to own and its build has found no owner for.
 */
export const unattributedOf = (owner: object): ReadonlyArray<object> =>
  Arr.filter(
    Array.from(unattributed.get(owner) ?? []),
    (schema) => builds.get(owner)?.resolved.has(schema) !== true,
  );
