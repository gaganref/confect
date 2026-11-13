import * as KernelRefusal from "./KernelRefusal.js";

/**
 * Convex refuses I/O inside a query or mutation. The binary answers `fetch`,
 * `setTimeout` and `setInterval` there with an async op that its query and
 * mutation environment refuses (`start_async_op` in
 * `crates/isolate/src/environment/udf/mod.rs`, `not_allowed_in_udf` at
 * `:264-272`, at the local backend's `cccbade`), and its runtime has no
 * `setImmediate` at all. The kernel wraps these globals so each call checks the
 * kernel function running it, whoever holds the reference: a module that kept
 * the global at load, a nested call, or a test that replaced it. Outside a
 * kernel query or mutation every wrapper calls the host's function.
 *
 * One rule is the kernel's own: a raw `fetch` in an action, a Node action
 * included, dies with `BackendRefusal` `UndeclaredFetch`, where the binary
 * performs it. Egress goes through a provider port (`Egress.ts`) instead.
 */

type UdfType = "query" | "mutation" | "action";

/**
 * The kernel function a call runs in.
 */
export interface Running {
  readonly udfType: UdfType;
  readonly componentPath: string;
  readonly udfPath: string;
}

export interface Hooks {
  /**
   * The kernel function running in the caller's async context, if any.
   */
  readonly running: () => Running | undefined;
  /**
   * End the running function with `error`: it fails with `error` once its
   * handler returns, as the binary terminates a function at its next microtask
   * checkpoint, and its later syscalls and calls are refused.
   */
  readonly end: (error: unknown) => void;
}

const timers = ["setTimeout", "setInterval"] as const;

type Timer = (typeof timers)[number];

/**
 * The binary's text for an operation a query or mutation may not use
 * (`not_allowed_in_udf`).
 */
const notAllowed = (description: string) =>
  `Can't use ${description} in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.`;

/**
 * What a query's or mutation's `fetch(url)` rejects with on the binary: its op
 * error, which `fetchWithoutRedirect` rewraps as a `TypeError` naming the
 * target without its query string (`npm-packages/udf-runtime/src/26_fetch.ts`
 * `:78-113`).
 */
export const fetchInTransaction = (url: string): TypeError => {
  const { origin, pathname, search, hash } = new URL(url);
  const target = `${origin}${pathname}`;
  const cause = notAllowed("fetch()")
    .replaceAll(url, () => target)
    .replaceAll(`${target}${search}${hash}`, () => target);
  return new TypeError(
    cause.includes(target) ? cause : `fetch to ${target} failed: ${cause}`,
  );
};

/**
 * What a query or mutation that starts `name` fails with on the binary. The
 * timer's sleep op rejects with no handler, so the function ends with it
 * (`run_inner`'s unhandled rejection check in
 * `crates/isolate/src/environment/udf/mod.rs:1121-1137`), whatever the handler
 * catches.
 */
export const timerInTransaction = (name: Timer): Error =>
  new Error(notAllowed(name));

interface State {
  readonly hooks: Hooks;
  /**
   * The wrappers and accessors this module installed, so a later install skips
   * them.
   */
  readonly installed: WeakSet<object>;
  nextTimerId: number;
}

const key = Symbol.for("@confect/test/IoBans");

type Global = { [key]?: State } & Record<string, unknown>;

const inTransaction = ({ hooks }: State): boolean => {
  const running = hooks.running();
  return running !== undefined && running.udfType !== "action";
};

const guardFetch = (state: State, base: (...args: Array<unknown>) => unknown) =>
  new Proxy(base, {
    apply: (target, self, args) => {
      const running = state.hooks.running();
      if (running === undefined) return Reflect.apply(target, self, args);
      // As on the binary, the request is built first, so a malformed one
      // rejects with the host's own error.
      let request: Request;
      try {
        request = new Request(
          ...(args as ConstructorParameters<typeof Request>),
        );
      } catch (error) {
        return Promise.reject(error);
      }
      if (running.udfType !== "action") {
        return Promise.reject(fetchInTransaction(request.url));
      }
      const refusal = KernelRefusal.undeclaredFetch(
        running.componentPath,
        running.udfPath,
        new URL(request.url).host,
      );
      // The action dies whatever its handler catches.
      state.hooks.end(refusal);
      return Promise.reject(refusal);
    },
  });

const guardTimer = (
  state: State,
  name: Timer,
  base: (...args: Array<unknown>) => unknown,
) =>
  new Proxy(base, {
    apply: (target, self, args) => {
      if (!inTransaction(state)) return Reflect.apply(target, self, args);
      // The binary's timer returns its ID before its sleep op is refused.
      state.hooks.end(timerInTransaction(name));
      return state.nextTimerId++;
    },
  });

/**
 * Replace `name` with `guard` of its current value, unless that value is
 * already one of this module's.
 */
const wrap = (
  state: State,
  name: string,
  guard: (base: (...args: Array<unknown>) => unknown) => object,
) => {
  const global = globalThis as unknown as Global;
  const current = global[name];
  if (typeof current !== "function" || state.installed.has(current)) return;
  const wrapper = guard(current as (...args: Array<unknown>) => unknown);
  state.installed.add(wrapper);
  global[name] = wrapper;
};

/**
 * The binary's runtime defines no `setImmediate`, so inside a kernel query or
 * mutation the global reads `undefined`, and feature detection takes the path
 * it takes there.
 */
const hideImmediate = (state: State) => {
  const global = globalThis as unknown as Global;
  const own = Object.getOwnPropertyDescriptor(global, "setImmediate");
  if (own === undefined || own.configurable === false) return;
  // oxlint-disable-next-line typescript/unbound-method -- Compared by identity, never called.
  if (own.get !== undefined && state.installed.has(own.get)) return;
  let base = own;
  const get = () => {
    if (inTransaction(state)) return undefined;
    return "value" in base ? base.value : base.get?.call(global);
  };
  const set = (value: unknown) => {
    if (base.set !== undefined) base.set.call(global, value);
    else base = { ...base, value };
  };
  state.installed.add(get);
  Object.defineProperty(global, "setImmediate", {
    get,
    set,
    configurable: true,
    enumerable: own.enumerable ?? false,
  });
};

/**
 * Wrap `fetch`, `setTimeout` and `setInterval`, and hide `setImmediate`, unless
 * the kernel already did. The first install's hooks answer for every later one,
 * as with `globalThis.Convex`. A test that replaces one of these globals
 * replaces the wrapper, and the next install wraps what it left.
 */
export const install = (hooks: Hooks) => {
  const global = globalThis as unknown as Global;
  const state = (global[key] ??= {
    hooks,
    installed: new WeakSet(),
    nextTimerId: 1,
  });
  wrap(state, "fetch", (base) => guardFetch(state, base));
  for (const name of timers) {
    wrap(state, name, (base) => guardTimer(state, name, base));
  }
  hideImmediate(state);
};
