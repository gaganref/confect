import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which database schemas each module's load registered push checks for, so a
 * test backend finds a component's checks from its own modules, whatever kit
 * registered it and whether or not any entry runs them.
 *
 * `@confect/server`'s `PushCheck.register` tells every observer in the set
 * under `Symbol.for("@confect/server/PushCheck/observers/v1")` of each schema
 * it registers a check for. While a module loads under {@link record}, the
 * observer adds that schema to the load's own set, which an async context
 * carries into the module's code and every module it imports first. The load's
 * namespace then keeps those schemas, so a later load of the same cached
 * module, which registers nothing again, still names them.
 */

const observersKey = Symbol.for("@confect/server/PushCheck/observers/v1");

/**
 * The schemas the loads running now registered checks for, innermost first.
 */
const loading = new AsyncLocalStorage<Set<object>>();

/**
 * The schemas each module namespace's load registered checks for.
 */
const traced = new WeakMap<object, Set<object>>();

const observe = (schema: object) => {
  loading.getStore()?.add(schema);
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
 * Run `load`, a module loader, keeping the schemas its load registers checks
 * for on the namespace it resolves to. A nested load keeps its own and passes
 * them to the load around it, as a module's imports load inside its own.
 */
export const record = <A>(load: () => Promise<A>): Promise<A> => {
  const schemas = new Set<object>();
  const outer = loading.getStore();
  return loading
    .run(schemas, () => Promise.resolve().then(load))
    .then((namespace) => {
      if (isNamespace(namespace) && schemas.size > 0) {
        const kept = traced.get(namespace);
        if (kept === undefined) traced.set(namespace, schemas);
        else for (const schema of schemas) kept.add(schema);
      }
      if (outer !== undefined) for (const schema of schemas) outer.add(schema);
      return namespace;
    });
};

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
