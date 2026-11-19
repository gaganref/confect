import { AsyncLocalStorage } from "node:async_hooks";
import * as Owner from "./Owner.js";

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
  /**
   * The lookups a copy from before #159 added. This copy reads none of them.
   */
  readonly lookups: Set<Lookup>;
  /**
   * Each loaded copy's lookup, keyed by the copy (`Owner.self`). A state a copy
   * from before #159 made has none.
   */
  owned?: Owner.Registry<Lookup>;
  /**
   * The environment of the component whose modules are loading, as protocol v1
   * defines it (`Owner`): every copy's `process.env` reads it whenever the
   * owner's lookup names none. So it holds a load's environment and nothing
   * else. A copy from #159 on enters it for a load whose mount binds one. A
   * newer copy enters it for every load, with none for a mount that binds none,
   * and with none for every function it runs, since no module loads in a
   * function. It never holds a function's environment: an older copy whose
   * function or load binds none reads this store, and would take that
   * function's as its own (#213).
   */
  readonly loading: AsyncLocalStorage<Env | undefined>;
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

/**
 * The environment of the code running now, from the lookup of the copy that
 * owns the innermost function or load (`Owner`), else of the component whose
 * modules are loading.
 */
const bound = ({ owned, loading }: State): Env | undefined =>
  (owned === undefined ? undefined : Owner.pick(owned)?.()) ??
  loading.getStore();

/**
 * Whether a copy of the kernel from before #159 installed the `process.env`
 * proxy, which reads its lookups and no other copy's.
 */
export const installedByOlderCopy = (): boolean => {
  const found = (globalThis as { [key]?: State })[key];
  return found !== undefined && found.installed && found.owned === undefined;
};

/**
 * Run `load` with `env` as the environment its module code reads, as a
 * deployment evaluates a component's modules with its own environment. With
 * none, the host's, never an enclosing load's (#213).
 */
export const loading = <A>(env: Env | undefined, load: () => A): A =>
  state().loading.run(env, load);

/**
 * Run `run`, a function, where no module loads, so no load's environment
 * answers for it or for a function or load of an older copy inside it. The
 * function's own environment comes from its copy's lookup.
 */
export const running = <A>(run: () => A): A =>
  state().loading.run(undefined, run);

/**
 * Answer `process.env` from `lookup`'s environment whenever it names one. Each
 * kernel copy's lookup replaces its last; the proxy goes in once per runtime,
 * and answers from the copy that owns what runs now.
 */
export const install = (lookup: Lookup) => {
  const current = state();
  (current.owned ??= Owner.registry()).set(Owner.self, lookup);
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
