import { AsyncLocalStorage } from "node:async_hooks";
import * as Schema from "effect/Schema";
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
  /**
   * The deployment site URL the code running now reads in place of the host's,
   * as a mounted component's router reads its mount's, without changing the
   * host's environment. A state an older copy made has none until a copy adds
   * it.
   */
  siteUrl?: AsyncLocalStorage<string | undefined>;
  /**
   * The host's environment, behind the proxy, which an override never changes.
   */
  host?: Record<string, string | undefined>;
  /**
   * The proxy this copy put in `process.env`, so a suite that replaces
   * `process.env` with an object of its own is seen and the proxy goes in again
   * over it. A proxy an older copy installed has none, and stays.
   */
  proxy?: Record<string, string | undefined>;
  /**
   * Each proxy a copy that answers site URL overrides installed, with the
   * host's environment behind it, under the capability's versioned key: v1
   * answers `CONVEX_SITE_URL` from {@link withSiteUrl}'s override in every
   * trap. A proxy a suite saved and put back is found here and used as it is,
   * never wrapped again. A proxy missing from it cannot answer an override.
   */
  [siteUrlCapability]?: WeakMap<object, Record<string, string | undefined>>;
  installed: boolean;
}

/**
 * The installed `process.env` proxy cannot answer a mounted router's site URL,
 * as one installed by an older loaded copy of `@confect/test`, which knows no
 * override, does not. A mounted router would read the host's site URL, without
 * its mount's prefix.
 */
export class SiteUrlOverrideUnsupported extends Schema.TaggedError<
  SiteUrlOverrideUnsupported,
  { readonly brand: unique symbol }
>()("SiteUrlOverrideUnsupported", {
  /**
   * The capability the installed proxy lacks.
   */
  capability: Schema.String,
}) {
  override get message(): string {
    return `The process.env proxy an older loaded copy of @confect/test installed does not support ${this.capability}, which a mounted component's router needs to read its mount's site URL. Load a single version of @confect/test in the test runtime.`;
  }
}

const key = Symbol.for("@confect/test/Environment");

/**
 * The capability a proxy answering {@link withSiteUrl}'s override has, by its
 * protocol's version.
 */
const siteUrlCapability = Symbol.for(
  "@confect/test/Environment/siteUrlOverride/v1",
);

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
export const loading = <A>(env: Env | undefined, load: () => A): A => {
  const current = state();
  if (current.installed) installProxy(current);
  return current.loading.run(env, load);
};

/**
 * Run `run`, a function, where no module loads, so no load's environment
 * answers for it or for a function or load of an older copy inside it. The
 * function's own environment comes from its copy's lookup.
 */
export const running = <A>(run: () => A): A => {
  const current = state();
  if (current.installed) installProxy(current);
  return current.loading.run(undefined, run);
};

const siteUrls = (current: State): AsyncLocalStorage<string | undefined> =>
  (current.siteUrl ??= new AsyncLocalStorage());

/**
 * Run `run` with `siteUrl` as the `CONVEX_SITE_URL` every read of `process.env`
 * inside it answers, the host's environment unchanged, so concurrent backends
 * each read their own. The proxy that answers it is installed first.
 */
export const withSiteUrl = <A>(siteUrl: string, run: () => A): A => {
  requireSiteUrlOverride();
  return siteUrls(state()).run(siteUrl, run);
};

/**
 * The host's own value of `name`, never an override's or a component's.
 */
export const hostValue = (name: string): string | undefined => {
  const current = state();
  if (current.installed) installProxy(current);
  return (current.host ?? process.env)[name];
};

/**
 * Answer `process.env` from `lookup`'s environment whenever it names one. Each
 * kernel copy's lookup replaces its last; the proxy goes in once per runtime,
 * and answers from the copy that owns what runs now.
 */
export const install = (lookup: Lookup) => {
  const current = state();
  (current.owned ??= Owner.registry()).set(Owner.self, lookup);
  installProxy(current);
};

/**
 * Put the `process.env` proxy in, once per runtime, answering from no copy's
 * lookup until one installs its own, and again over whatever object a suite put
 * in `process.env` in its place, which is then the host's environment.
 */
const installProxy = (current: State) => {
  current.owned ??= Owner.registry();
  if (
    current.installed &&
    (current.proxy === undefined || process.env === current.proxy)
  )
    return;
  const proxies = (current[siteUrlCapability] ??= new WeakMap());
  // A proxy of ours that a suite saved and put back answers as it did, over
  // the host it was made for.
  const restored = proxies.get(process.env);
  if (restored !== undefined) {
    current.installed = true;
    current.host = restored;
    current.proxy = process.env;
    return;
  }
  current.installed = true;
  const host = process.env;
  current.host = host;
  const overridden = (name: PropertyKey): string | undefined =>
    name === "CONVEX_SITE_URL" ? siteUrls(current).getStore() : undefined;
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
  const proxy = new Proxy(host, {
    // An assignment or definition goes to the host's environment itself, as
    // Node accepts it only without the proxy as its receiver.
    set: (target, name, value) => Reflect.set(target, name, value),
    defineProperty: (target, name, attributes) =>
      Reflect.defineProperty(target, name, attributes),
    get: (target, name) => {
      const override = overridden(name);
      if (override !== undefined) return override;
      const env = typeof name === "string" ? scoped() : undefined;
      return env === undefined
        ? Reflect.get(target, name)
        : env[name as string];
    },
    has: (target, name) => {
      if (overridden(name) !== undefined) return true;
      const env = typeof name === "string" ? scoped() : undefined;
      return env === undefined ? Reflect.has(target, name) : name in env;
    },
    ownKeys: (target) => {
      const env = scoped();
      const keys =
        env === undefined ? Reflect.ownKeys(target) : Reflect.ownKeys(env);
      // An override is a key of the view, as `get` and `has` answer it.
      return overridden("CONVEX_SITE_URL") !== undefined &&
        !keys.includes("CONVEX_SITE_URL")
        ? [...keys, "CONVEX_SITE_URL"]
        : keys;
    },
    getOwnPropertyDescriptor: (target, name) => {
      const override = overridden(name);
      if (override !== undefined) return descriptor(override);
      const env = typeof name === "string" ? scoped() : undefined;
      if (env === undefined)
        return Reflect.getOwnPropertyDescriptor(target, name);
      const value = env[name as string];
      return value === undefined ? undefined : descriptor(value);
    },
  });
  proxies.set(proxy, host);
  current.proxy = proxy;
  process.env = proxy;
};

/**
 * Refuse, with {@link SiteUrlOverrideUnsupported}, when the installed
 * `process.env` proxy cannot answer a site URL override, rather than let a
 * mounted router silently read the host's site URL.
 */
export const requireSiteUrlOverride = (): void => {
  const current = state();
  installProxy(current);
  if (current[siteUrlCapability]?.has(process.env) !== true)
    throw SiteUrlOverrideUnsupported.make({
      capability: siteUrlCapability.description ?? "",
    });
};
