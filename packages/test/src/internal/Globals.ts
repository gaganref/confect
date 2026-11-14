import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Convex gives every function execution its own globals. The kernel gives each
 * function call it starts its own copy of the globals a test invocation pins,
 * as convex-test 0.0.65 does for every handler (its `dist/index.js:1744`,
 * `:1883-1905` and `:1927-1930`). An assignment inside the call lands in its
 * copy only, so the invocation bridge's pins stay with the handler that made
 * them, and overlapping or nested calls keep their own.
 */

const names = ["Date", "Math", "crypto"] as const;

type Name = (typeof names)[number];

type Copies = { [name in Name]?: unknown };

interface State {
  readonly copies: AsyncLocalStorage<Copies>;
  /**
   * The getters this module installed, so a later install skips them.
   */
  readonly getters: WeakSet<() => unknown>;
}

const key = Symbol.for("@confect/test/Globals");

// One store per test runtime, so every copy of this module reads the same
// copies.
const state = (): State =>
  ((globalThis as { [key]?: State })[key] ??= {
    copies: new AsyncLocalStorage(),
    getters: new WeakSet(),
  });

/**
 * Whether `accessor`, another library's, already reads through one of this
 * module's, as convex-test's does once it wraps the kernel's: it answers a
 * value only a fresh copy holds. convex-test reinstalls its accessor whenever
 * another is on top (its `dist/index.js:1854-1866`), so wrapping it again would
 * add a layer at every call while both kinds of world are live.
 */
const readsThrough = (
  copies: State["copies"],
  accessor: PropertyDescriptor,
  name: Name,
): boolean => {
  const probe = {};
  return (
    copies.run({ [name]: probe }, () => accessor.get?.call(globalThis)) ===
    probe
  );
};

/**
 * Point each global at the calling function's copy, falling back to the
 * global's own value outside one. A test that redefines a global, as
 * `vi.stubGlobal` does, removes the accessor, so every call installs it again
 * over what the test left.
 */
const install = (current: State, name: Name) => {
  const { copies, getters } = current;
  const global = globalThis as unknown as Record<Name, unknown>;
  {
    const own = Object.getOwnPropertyDescriptor(global, name);
    // oxlint-disable-next-line typescript/unbound-method -- Compared by identity, never called.
    if (own?.get !== undefined && getters.has(own.get)) return;
    if (own?.get !== undefined && readsThrough(copies, own, name)) return;
    const base: PropertyDescriptor = own ?? {
      value: undefined,
      writable: true,
    };
    const get = () => {
      const copy = copies.getStore();
      if (copy !== undefined && name in copy) return copy[name];
      return "value" in base ? base.value : base.get?.call(global);
    };
    const set = (value: unknown) => {
      const copy = copies.getStore();
      if (copy !== undefined) copy[name] = value;
      else if ("value" in base && base.writable === true) base.value = value;
      else if (base.set !== undefined) base.set.call(global, value);
      else throw new TypeError(`Cannot assign to read only global '${name}'`);
    };
    try {
      Object.defineProperty(global, name, {
        get,
        set,
        configurable: true,
        enumerable: own?.enumerable ?? false,
      });
      getters.add(get);
    } catch {
      // A global that cannot be redefined keeps no copy, and the bridge
      // refuses to pin it.
    }
  }
};

/**
 * Run `call` with a fresh copy of the globals. It starts from the test
 * environment's, whatever the caller assigned in its own copy. `Date` gets its
 * accessor here. `Math` and `crypto` get theirs from {@link prepare}, which the
 * kernel's entropy install calls inside the boundary that turns any failure
 * into its refusal.
 */
export const own = <A>(call: () => A): A => {
  const current = state();
  install(current, "Date");
  return current.copies.run({}, call);
};

/**
 * Give `name` this module's accessor, as {@link own} does for `Date`. It may
 * throw, from a test's getter that `readsThrough` calls, so its caller runs it
 * inside its own refusal boundary.
 */
export const prepare = (name: "Math" | "crypto"): void => {
  install(state(), name);
};

/**
 * Read `read` against the test environment's globals, never a function call's
 * copy, as the kernel's own clock must.
 */
export const host = <A>(read: () => A): A => state().copies.exit(read);
