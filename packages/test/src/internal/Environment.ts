declare const process: { env: Record<string, string | undefined> };

/**
 * Convex gives each component the environment its mount binds and nothing else,
 * beside the deployment's system URLs. The kernel answers `process.env` inside
 * a function of a component with a bound environment from that environment, and
 * everywhere else from the host's, as before.
 */

/**
 * The keys every component reads from the deployment, as Convex sets them.
 */
const system = new Set(["CONVEX_CLOUD_URL", "CONVEX_SITE_URL"]);

type Lookup = () => Readonly<Record<string, string>> | undefined;

interface State {
  readonly lookups: Set<Lookup>;
  installed: boolean;
}

const key = Symbol.for("@confect/test/Environment");

// One state per test runtime, so every copy of the kernel answers through the
// same proxy.
const state = (): State =>
  ((globalThis as { [key]?: State })[key] ??= {
    lookups: new Set(),
    installed: false,
  });

const bound = (lookups: Set<Lookup>) => {
  for (const lookup of lookups) {
    const env = lookup();
    if (env !== undefined) return env;
  }
  return undefined;
};

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
  const read = (name: string | symbol) => {
    const env = typeof name === "string" ? bound(current.lookups) : undefined;
    return env === undefined || system.has(name as string)
      ? undefined
      : { env };
  };
  process.env = new Proxy(host, {
    // An assignment or definition goes to the host's environment itself, as
    // Node accepts it only without the proxy as its receiver.
    set: (target, name, value) => Reflect.set(target, name, value),
    defineProperty: (target, name, descriptor) =>
      Reflect.defineProperty(target, name, descriptor),
    get: (target, name) => {
      const scoped = read(name);
      return scoped === undefined
        ? Reflect.get(target, name)
        : scoped.env[name as string];
    },
    has: (target, name) => {
      const scoped = read(name);
      return scoped === undefined
        ? Reflect.has(target, name)
        : (name as string) in scoped.env;
    },
    getOwnPropertyDescriptor: (target, name) => {
      const scoped = read(name);
      if (scoped === undefined)
        return Reflect.getOwnPropertyDescriptor(target, name);
      const value = scoped.env[name as string];
      return value === undefined
        ? undefined
        : { value, writable: true, enumerable: true, configurable: true };
    },
  });
};
