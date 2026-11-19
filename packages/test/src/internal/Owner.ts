import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which loaded copy of the kernel owns the innermost function or module load
 * running in the caller's async context.
 *
 * An install can load two copies of `@confect/test`, and a function of one
 * copy's backend can call into the other's, as a test that calls one session
 * from another's action does. Each copy keeps its functions in its own
 * async-local store, so inside such a call both copies' stores hold one. The
 * process-wide hooks, the I/O guards, `globalThis.Convex`, the `Date` wrapper,
 * the provider-port holder and `process.env`, answer for the copy this one
 * store names, which each copy enters as it starts a function or a load, so the
 * innermost wins however the copies were loaded.
 */

/**
 * This copy of the kernel. Each copy's module has its own.
 */
export const self: object = {};

/**
 * The store every copy shares, one per process. The key names its protocol's
 * version, so a later protocol takes a store of its own.
 *
 * How copies of different versions coexist (#214): this store and every other
 * process-wide value a copy keeps under a `Symbol.for("@confect/test/...")`
 * key, such as `Environment`'s `loading` store and the hook registries, keep
 * the meaning the release that introduced them gave them. A newer copy may
 * extend that protocol only compatibly: it stores only values an older copy
 * reads as that release defined them, and its registry entries answer as that
 * release's callers expect. A change that cannot do so takes a new versioned
 * key, and a newer copy then detects the older protocol and refuses with a
 * typed error before it installs anything, as `OlderCopyLoadedFirst` refuses a
 * copy from before #159. It never shares a store whose meaning changed.
 */
const key = Symbol.for("@confect/test/Owner/v1");

type Global = { [key]?: AsyncLocalStorage<object> };

const storage = (): AsyncLocalStorage<object> =>
  ((globalThis as Global)[key] ??= new AsyncLocalStorage());

/**
 * Run `run` as this copy's: a function or a module load this copy starts.
 */
export const enter = <A>(run: () => A): A => storage().run(self, run);

/**
 * The copy that owns the innermost function or load running now, if any.
 */
export const current = (): object | undefined => storage().getStore();

/**
 * What `registry` holds for the copy that owns what runs now, if any.
 */
export const pick = <A>(registry: ReadonlyMap<object, A>): A | undefined => {
  const owner = current();
  return owner === undefined ? undefined : registry.get(owner);
};
