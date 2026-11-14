import { AsyncLocalStorage } from "node:async_hooks";

declare const process: { env: Record<string, string | undefined> };

/**
 * Convex gives each component the environment its mount binds and nothing else,
 * beside the deployment's system URLs, both while its modules load and while
 * its functions run. The kernel answers `process.env` there from that
 * environment, as a plain object of those settings, and everywhere else from
 * the host's, as before.
 */

/**
 * The keys every component reads from the deployment, as Convex sets them.
 */
const system = ["CONVEX_CLOUD_URL", "CONVEX_SITE_URL"] as const;

type Env = Readonly<Record<string, string>>;

type Lookup = () => Env | undefined;

interface State {
  readonly lookups: Set<Lookup>;
  /**
   * The environment of the component whose modules are loading.
   */
  readonly loading: AsyncLocalStorage<Env>;
  installed: boolean;
}

const key = Symbol.for("@confect/test/Environment");

// One state per test runtime, so every copy of the kernel answers through the
// same proxy.
const state = (): State =>
  ((globalThis as { [key]?: State })[key] ??= {
    lookups: new Set(),
    loading: new AsyncLocalStorage(),
    installed: false,
  });

const bound = ({ lookups, loading }: State): Env | undefined => {
  for (const lookup of lookups) {
    const env = lookup();
    if (env !== undefined) return env;
  }
  return loading.getStore();
};

/**
 * Run `load` with `env` as the environment its module code reads, as a
 * deployment evaluates a component's modules with its own environment.
 */
export const loading = <A>(env: Env | undefined, load: () => A): A =>
  env === undefined ? load() : state().loading.run(env, load);

/**
 * Answer `process.env` from `lookup`'s environment whenever it names one. Each
 * kernel copy installs its lookup once; the proxy goes in once per runtime.
 */
export const install = (lookup: Lookup) => {
  const current = state();
  current.lookups.add(lookup);
  if (current.installed) return;
  current.installed = true;
  const host = process.env;
  // The component's view: its own settings, then the system URLs the host has.
  const view = (env: Env): Env => {
    const seen: Record<string, string> = { ...env };
    for (const name of system) {
      const value = host[name];
      if (value !== undefined) seen[name] = value;
    }
    return seen;
  };
  const scoped = () => {
    const env = bound(current);
    return env === undefined ? undefined : view(env);
  };
  const descriptor = (value: string) => ({
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  process.env = new Proxy(host, {
    // An assignment or definition goes to the host's environment itself, as
    // Node accepts it only without the proxy as its receiver.
    set: (target, name, value) => Reflect.set(target, name, value),
    defineProperty: (target, name, attributes) =>
      Reflect.defineProperty(target, name, attributes),
    get: (target, name) => {
      const env = typeof name === "string" ? scoped() : undefined;
      return env === undefined
        ? Reflect.get(target, name)
        : env[name as string];
    },
    has: (target, name) => {
      const env = typeof name === "string" ? scoped() : undefined;
      return env === undefined ? Reflect.has(target, name) : name in env;
    },
    ownKeys: (target) => {
      const env = scoped();
      return env === undefined ? Reflect.ownKeys(target) : Reflect.ownKeys(env);
    },
    getOwnPropertyDescriptor: (target, name) => {
      const env = typeof name === "string" ? scoped() : undefined;
      if (env === undefined)
        return Reflect.getOwnPropertyDescriptor(target, name);
      const value = env[name as string];
      return value === undefined ? undefined : descriptor(value);
    },
  });
};
