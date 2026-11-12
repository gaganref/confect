/**
 * Convex pins `Date` inside a query or mutation to the time it started, and its
 * scheduler reads `Date.now()` for `runAfter`. The kernel wraps the realm's
 * `Date` so it answers a kernel invocation's time inside one and the host's
 * everywhere else. It sets no host timer.
 */

import * as Globals from "./Globals.js";

type DateConstructor = typeof globalThis.Date;

interface State {
  /**
   * Each wrapper the kernel installed, and the `Date` it wraps.
   */
  readonly bases: WeakMap<DateConstructor, DateConstructor>;
  readonly pinned: () => number | undefined;
  /**
   * Whether a kernel invocation is running, without reading its time.
   */
  readonly inside: () => boolean;
}

const key = Symbol.for("@confect/test/Clock");

type Global = { [key]?: State; Date: DateConstructor };

const wrap = (
  base: DateConstructor,
  pinned: () => number | undefined,
): DateConstructor => {
  const proxy: DateConstructor = new Proxy(base, {
    get: (target, property) =>
      property === "now"
        ? () => pinned() ?? target.now()
        : Reflect.get(target, property, target),
    construct: (target, args, newTarget) => {
      const at = args.length === 0 ? pinned() : undefined;
      return Reflect.construct(
        target,
        at === undefined ? args : [at],
        newTarget === proxy ? target : newTarget,
      );
    },
    apply: (target, self, args) => {
      const at = pinned();
      return at === undefined
        ? Reflect.apply(target, self, args)
        : new target(at).toString();
    },
  });
  return proxy;
};

/**
 * Wrap the realm's current `Date`, unless the kernel already did. `pinned`
 * answers the running invocation's time, or `undefined` outside one, and
 * `inside` says whether one is running. The first install's callbacks answer
 * for every later one, as with `globalThis.Convex`. A test that fakes `Date`
 * replaces the wrapper while the fake is installed, and the next install wraps
 * the `Date` the test restores.
 */
export const install = (
  pinned: () => number | undefined,
  inside: () => boolean,
) => {
  const global = globalThis as Global;
  const state = (global[key] ??= { bases: new WeakMap(), pinned, inside });
  const current = global.Date;
  if (state.bases.has(current)) return;
  const wrapper = wrap(current, () => state.pinned());
  state.bases.set(wrapper, current);
  global.Date = wrapper;
};

/**
 * Whether `date` is the kernel's wrapper inside a running kernel invocation, so
 * it already answers that invocation's time on the kernel's clock.
 */
export const answersInvocation = (date: DateConstructor): boolean => {
  const state = (globalThis as Global)[key];
  return state !== undefined && state.bases.has(date) && state.inside();
};

/**
 * The host's time in milliseconds, never a kernel invocation's: the real clock,
 * or a test's fake one while it is installed. It reads the test environment's
 * `Date`, never the copy a bound handler pinned.
 */
export const hostNow = (): number =>
  Globals.host(() => {
    const global = globalThis as Global;
    const current = global.Date;
    return (global[key]?.bases.get(current) ?? current).now();
  });
