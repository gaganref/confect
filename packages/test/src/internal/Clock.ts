/**
 * Convex pins `Date` inside a query or mutation to the time it started, and its
 * scheduler reads `Date.now()` for `runAfter`. The kernel wraps the realm's
 * `Date` so it answers a kernel invocation's time inside one and the host's
 * everywhere else. It sets no host timer.
 */

// oxlint-disable effecttsgo/global-date -- This module is the kernel's Date: it answers Date.now from the pinned time or from the host Date it wraps.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Globals from "./Globals.js";

type DateConstructor = typeof globalThis.Date;

/**
 * One loaded copy of the kernel's clock: the running invocation's time, and
 * whether one of that copy's invocations is running.
 */
interface Pin {
  readonly pinned: () => number | undefined;
  readonly inside: () => boolean;
}

interface State {
  /**
   * Each wrapper the kernel installed, and the `Date` it wraps.
   */
  readonly bases: WeakMap<DateConstructor, DateConstructor>;
  pinned: Pin["pinned"];
  /**
   * Whether a kernel invocation is running, without reading its time.
   */
  inside: Pin["inside"];
  /**
   * Each loaded copy's pin, in install order. Optional, as a state a copy from
   * before #159 made has none. Once it is set, `pinned` and `inside` ask every
   * pin in it.
   */
  pins?: Array<Pin>;
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
 * Add `pin` to the copies `state` asks, unless its `pinned` is there. Each copy
 * keeps its invocations in its own async-local store, so at most one copy's
 * `inside` holds in a context, and that copy answers the time.
 */
const join = (state: State, pin: Pin) => {
  if (state.pins === undefined) {
    // The state's own pin: this copy's, or one from before #159.
    const pins: Array<Pin> = [{ pinned: state.pinned, inside: state.inside }];
    state.pins = pins;
    const running = () =>
      Option.getOrUndefined(Arr.findFirst(pins, (each) => each.inside()));
    state.pinned = () => running()?.pinned();
    state.inside = () => running() !== undefined;
  }
  if (!Arr.some(state.pins, (each) => each.pinned === pin.pinned)) {
    state.pins.push(pin);
  }
};

/**
 * Wrap the realm's current `Date`, unless the kernel already did. `pinned`
 * answers the running invocation's time, or `undefined` outside one, and
 * `inside` says whether one is running. The wrapper is one per realm, whichever
 * copy of the kernel installed it, and answers the time of whichever copy's
 * invocation is running. A test that fakes `Date` replaces the wrapper while
 * the fake is installed, and the next install wraps the `Date` the test
 * restores.
 */
export const install = (
  pinned: () => number | undefined,
  inside: () => boolean,
) => {
  const global = globalThis as Global;
  const state = (global[key] ??= { bases: new WeakMap(), pinned, inside });
  join(state, { pinned, inside });
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
