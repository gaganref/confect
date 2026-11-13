/**
 * Convex refuses I/O inside a query or mutation, and its isolate runtime lacks
 * some of Node's globals. The binary answers `fetch`, `setTimeout`,
 * `setInterval` and a multipart `formData()` in a query or mutation with an
 * async op its query and mutation environment refuses (`start_async_op` in
 * `crates/isolate/src/environment/udf/mod.rs:367-375`, `not_allowed_in_udf` at
 * `:264-272`, at the local backend's `cccbade4`). Its isolate defines no
 * `setImmediate` and no `queueMicrotask`
 * (`npm-packages/udf-runtime/src/setup.ts` installs neither), in queries,
 * mutations and actions alike, while a Node action runs in Node.
 *
 * Each of these globals is an accessor that reads as a guard of the
 * implementation beneath it. A guard checks the kernel function running in the
 * caller's async context at every call, so a reference taken at any time after
 * {@link install} ran is checked: a module that kept the global when it loaded,
 * a nested call, a handler or a test that assigned the global. An assignment
 * stores the new implementation beneath, still guarded, and outside a kernel
 * function that is refused, a guard calls the implementation it was read with.
 */

import * as Util from "node:util";

type UdfType = "query" | "mutation" | "action";

/**
 * Which Convex runtime a function runs in: the V8 isolate, for queries,
 * mutations and actions, or Node, for a `"use node"` action.
 */
export type Runtime = "isolate" | "node";

/**
 * The kernel function a call runs in.
 */
export interface Running {
  readonly udfType: UdfType;
  readonly runtime: Runtime;
}

export interface Hooks {
  /**
   * The kernel function running in the caller's async context, if any.
   */
  readonly running: () => Running | undefined;
  /**
   * End the running function with `error`: it fails with `error` at once,
   * whether or not its handler ever settles, as the binary terminates a
   * function at its next microtask checkpoint.
   */
  readonly end: (error: unknown) => void;
}

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

type Timer = "setTimeout" | "setInterval";

/**
 * What a query or mutation that starts `name` fails with on the binary. The
 * timer's sleep op rejects with no handler, so the function ends with it
 * (`run_inner`'s unhandled rejection check in
 * `crates/isolate/src/environment/udf/mod.rs:1121-1137`), whatever the handler
 * catches or awaits.
 */
export const timerInTransaction = (name: Timer): Error =>
  new Error(notAllowed(name));

/**
 * What a query's or mutation's `formData()` on a multipart body rejects with on
 * the binary: `parseFormData`'s `form/parseMultiPart` op error
 * (`npm-packages/udf-runtime/src/21_formdata.ts:126-150`).
 */
export const formDataInTransaction = (): Error =>
  new Error(notAllowed("formData()"));

interface State {
  hooks: Hooks | undefined;
  /**
   * Every guard and getter this module made, so an install skips a global it
   * already guards.
   */
  readonly made: WeakSet<object>;
  /**
   * The function each guard calls when the running function may.
   */
  readonly guarding: WeakMap<object, unknown>;
  /**
   * Set while an install reads another library's accessor, so the hidden
   * globals answer their guard whatever function is running.
   */
  probing: boolean;
  nextTimerId: number;
}

const key = Symbol.for("@confect/test/IoBans");

const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");

type Global = { [key]?: State } & Record<string, unknown>;

type Fn = (...args: Array<unknown>) => unknown;

const runningOf = (state: State) => state.hooks?.running();

const inTransaction = (running: Running | undefined): boolean =>
  running !== undefined && running.udfType !== "action";

const inIsolate = (state: State): boolean =>
  !state.probing && runningOf(state)?.runtime === "isolate";

/**
 * Node's own modules that read or call a global the isolate lacks while doing a
 * function's work: its `fetch`, `Request` and `Response`, whose bodies schedule
 * `queueMicrotask`. The binary's own built-ins need none of these globals, so
 * only the function's own code finds them absent. The set holds the exact
 * `node:` URLs the kernel's suites showed, so no other script, a user's that
 * names itself `node:` included, passes.
 */
const nodeCallers: ReadonlySet<string> = new Set([
  "node:internal/deps/undici/undici",
]);

/**
 * `util.getCallSites` (Node 22.9 and later), kept when this module loads. It
 * reads the stack without `Error.prepareStackTrace`, so a user's override
 * cannot change what it reports. Without it no caller counts as Node's.
 */
const callSites: typeof Util.getCallSites | undefined = Util.getCallSites;

const here = callSites?.(1)[0]?.scriptName;

/**
 * Whether the code reading or calling a global, the first frame outside this
 * module, is one of Node's own modules in {@link nodeCallers}.
 */
const readByNode = (): boolean => {
  const caller = callSites?.(12).find((site) => site.scriptName !== here);
  return caller !== undefined && nodeCallers.has(caller.scriptName);
};

/**
 * What a guard answers instead of calling the host's function, or `undefined`
 * when the running function may call it.
 */
type Rule = (
  state: State,
  running: Running,
  args: ReadonlyArray<unknown>,
  /**
   * Whether one of Node's own modules made the call.
   */
  calledByNode: () => boolean,
) => { readonly answer: unknown } | undefined;

const fetchRule: Rule = (_state, running, args) => {
  if (!inTransaction(running)) return undefined;
  // As on the binary, the request is built first, so a malformed one rejects
  // with the host's own error.
  let request: Request;
  try {
    request = new Request(...(args as ConstructorParameters<typeof Request>));
  } catch (error) {
    return { answer: Promise.reject(error) };
  }
  return { answer: Promise.reject(fetchInTransaction(request.url)) };
};

const timerRule =
  (name: Timer): Rule =>
  (state, running) => {
    if (!inTransaction(running)) return undefined;
    // The binary's timer returns its ID before its sleep op is refused.
    state.hooks?.end(timerInTransaction(name));
    return { answer: state.nextTimerId++ };
  };

/**
 * A reference to a global the isolate lacks, taken outside a function, fails
 * inside one as the missing global would.
 */
const absentRule =
  (name: string): Rule =>
  (_state, running, _args, calledByNode) => {
    if (running.runtime !== "isolate" || calledByNode()) return undefined;
    throw new ReferenceError(`${name} is not defined`);
  };

/**
 * `util.promisify(setTimeout)` and `util.promisify(setInterval)` read the
 * timer's promisified form. In a query or mutation it ends the function as the
 * timer does, and its promise never settles, as an ended function runs no more
 * JavaScript.
 */
const promisedTimerRule =
  (name: Timer): Rule =>
  (state, running) => {
    if (!inTransaction(running)) return undefined;
    state.hooks?.end(timerInTransaction(name));
    // oxlint-disable-next-line effecttsgo/new-promise -- A promise that never settles, as an ended function's await never resumes.
    return { answer: new Promise(() => {}) };
  };

const guarded: ReadonlyArray<{
  readonly name: string;
  readonly rule: Rule;
  /**
   * What a guard of the implementation's promisified form does, if not `rule`.
   */
  readonly promised?: Rule;
  /**
   * Whether the global reads `undefined` inside an isolate function.
   */
  readonly absent: boolean;
}> = [
  { name: "fetch", rule: fetchRule, absent: false },
  {
    name: "setTimeout",
    rule: timerRule("setTimeout"),
    promised: promisedTimerRule("setTimeout"),
    absent: false,
  },
  {
    name: "setInterval",
    rule: timerRule("setInterval"),
    promised: promisedTimerRule("setInterval"),
    absent: false,
  },
  { name: "setImmediate", rule: absentRule("setImmediate"), absent: true },
  { name: "queueMicrotask", rule: absentRule("queueMicrotask"), absent: true },
];

const makeGuard = (
  state: State,
  name: string,
  rule: Rule,
  implementation: () => unknown,
  promised?: Rule,
): Fn => {
  function guard(this: unknown, ...args: Array<unknown>): unknown {
    const running = runningOf(state);
    const refused =
      running === undefined
        ? undefined
        : rule(state, running, args, readByNode);
    if (refused !== undefined) return refused.answer;
    return Reflect.apply(implementation() as Fn, this, args);
  }
  Object.defineProperty(guard, "name", { value: name });
  // `util.promisify(setTimeout)` reads the implementation's promisified
  // form, which is guarded too.
  const promisified = new WeakMap<object, Fn>();
  Object.defineProperty(guard, promisifyCustom, {
    get: () => {
      const form = (implementation() as Record<symbol, unknown> | undefined)?.[
        promisifyCustom
      ];
      if (typeof form !== "function") return form;
      let guardedForm = promisified.get(form);
      if (guardedForm === undefined) {
        guardedForm = makeGuard(state, name, promised ?? rule, () => form);
        promisified.set(form, guardedForm);
      }
      return guardedForm;
    },
    configurable: true,
  });
  state.made.add(guard);
  return guard;
};

/**
 * Whether `accessor`, another library's, already reads through one of this
 * module's guards, as convex-test's does once it wraps the kernel's.
 * convex-test installs its accessor again whenever another is on top (its
 * `dist/index.js:1854-1866`), so guarding it again would add a layer at every
 * call while both kinds of world are live.
 */
const readsThrough = (state: State, accessor: PropertyDescriptor): boolean => {
  state.probing = true;
  try {
    return state.made.has(accessor.get?.call(globalThis) as object);
  } catch {
    return false;
  } finally {
    state.probing = false;
  }
};

/**
 * Make `name` an accessor that reads as a guard of the implementation beneath
 * it, unless it already reads through one. The value or accessor it replaces is
 * the first implementation. Each implementation has one guard, so a read
 * answers the same function until an assignment, and a reference keeps the
 * implementation it was read with, as a kept reference to the host's function
 * would: convex-test keeps the real `setTimeout` at load to run beside fake
 * timers (its `dist/index.js:2205`). An assignment stores a new implementation
 * beneath, still guarded, and assigning a guard back, as fake timers do when
 * they uninstall, stores the implementation it guards.
 */
const guardGlobal = (
  state: State,
  { name, rule, promised, absent }: (typeof guarded)[number],
): boolean => {
  const global = globalThis as unknown as Global;
  const own = Object.getOwnPropertyDescriptor(global, name);
  // A global that is gone leaves a function nothing of the host's to reach.
  if (own === undefined) return true;
  // oxlint-disable-next-line typescript/unbound-method -- Compared by identity, never called.
  if (own.get !== undefined && state.made.has(own.get)) return true;
  if (own.get !== undefined && readsThrough(state, own)) return true;
  // A replacement the kernel cannot redefine stays the host's.
  if (own.configurable === false) return false;
  let beneath: PropertyDescriptor = own;
  // Another library's accessor beneath answers per read, so one guard reads
  // through it at each call.
  const throughAccessor = makeGuard(
    state,
    name,
    rule,
    () => beneath.get?.call(global),
    promised,
  );
  const guards = new WeakMap<object, Fn>();
  const guardOf = (implementation: unknown): unknown => {
    if (typeof implementation !== "function") return implementation;
    let guard = guards.get(implementation);
    if (guard === undefined) {
      guard = makeGuard(state, name, rule, () => implementation, promised);
      guards.set(implementation, guard);
      state.guarding.set(guard, implementation);
    }
    return guard;
  };
  const get = (): unknown => {
    if (absent && inIsolate(state) && !readByNode()) return undefined;
    return "value" in beneath ? guardOf(beneath.value) : throughAccessor;
  };
  const set = (value: unknown) => {
    if (!("value" in beneath) && beneath.set !== undefined) {
      // Another library's accessor keeps its own store.
      beneath.set.call(global, value);
      return;
    }
    const implementation = state.guarding.has(value as object)
      ? state.guarding.get(value as object)
      : value;
    beneath = { value: implementation, writable: true };
  };
  state.made.add(get);
  try {
    Object.defineProperty(global, name, {
      get,
      set,
      configurable: true,
      enumerable: own.enumerable ?? false,
    });
  } catch {
    return false;
  }
  return true;
};

/**
 * A query's or mutation's `formData()` on a multipart body is refused, as on
 * the binary, which reads the body first. A urlencoded body parses in
 * JavaScript there and is allowed, and an action parses either.
 */
const guardFormData = (state: State, prototype: { formData?: unknown }) => {
  const original = prototype.formData;
  if (typeof original !== "function" || state.made.has(original)) return;
  const host = original as (this: Request | Response) => Promise<FormData>;
  function formData(this: Request | Response): Promise<FormData> {
    if (!inTransaction(runningOf(state))) return Reflect.apply(host, this, []);
    const [essence = "", ...parameters] = (
      this.headers.get("content-type") ?? ""
    ).split(";");
    if (essence.trim().toLowerCase() !== "multipart/form-data") {
      return Reflect.apply(host, this, []);
    }
    if (
      !parameters.some((parameter) =>
        parameter.trim().toLowerCase().startsWith("boundary="),
      )
    ) {
      return Promise.reject(
        new TypeError(
          "Missing boundary parameter in mime type of multipart formdata.",
        ),
      );
    }
    return this.arrayBuffer().then(() =>
      Promise.reject(formDataInTransaction()),
    );
  }
  state.made.add(formData);
  Object.defineProperty(prototype, "formData", {
    value: formData,
    writable: true,
    configurable: true,
    enumerable: false,
  });
};

const stateOf = (): State =>
  ((globalThis as unknown as Global)[key] ??= {
    hooks: undefined,
    made: new WeakSet(),
    guarding: new WeakMap(),
    probing: false,
    nextTimerId: 1,
  });

/**
 * Guard `fetch`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`
 * and multipart `formData()`, unless they are already guarded.
 * `@confect/test/setup` calls this before any test module loads, and the kernel
 * again whenever a world opens or a function starts, which adopts a global a
 * test redefined, as `vi.stubGlobal` does, as the implementation beneath a
 * fresh guard. It answers the names it could not guard: a replacement made
 * non-configurable, or one the realm refused to redefine.
 */
export const install = (): ReadonlyArray<string> => {
  const state = stateOf();
  const unguarded = guarded
    .filter((entry) => !guardGlobal(state, entry))
    .map(({ name }) => name);
  guardFormData(state, Request.prototype);
  guardFormData(state, Response.prototype);
  return unguarded;
};

const sameDescriptor = (
  before: PropertyDescriptor | undefined,
  now: PropertyDescriptor | undefined,
): boolean =>
  before === undefined || now === undefined
    ? before === now
    : before.get === now.get &&
      before.set === now.set &&
      "value" in before === "value" in now &&
      before.value === now.value;

/**
 * Take the guarded globals' descriptors as they are now, once a function's
 * entry has guarded them. The answer names, when called, each global whose
 * descriptor was replaced since, which a guard could not see: a call made
 * through the replacement reached it unchecked. An accessor another library
 * laid over a guard, as convex-test lays its own before each of its handlers
 * (its `index.ts:3054-3060`), still reads through the guard, so it is no
 * replacement. An assignment stores beneath the guard and replaces nothing.
 */
export const watch = (): (() => ReadonlyArray<string>) => {
  const state = stateOf();
  const global = globalThis as unknown as Global;
  const taken = guarded.map(
    ({ name }) =>
      [name, Object.getOwnPropertyDescriptor(global, name)] as const,
  );
  return () =>
    taken
      .filter(([name, before]) => {
        const now = Object.getOwnPropertyDescriptor(global, name);
        if (sameDescriptor(before, now)) return false;
        return !(
          now?.get !== undefined &&
          // oxlint-disable-next-line typescript/unbound-method -- Compared by identity, never called.
          !state.made.has(now.get) &&
          readsThrough(state, now)
        );
      })
      .map(([name]) => name);
};

/**
 * Give the guards the kernel's hooks. The first answers for every later one, as
 * with `globalThis.Convex`.
 */
export const bind = (hooks: Hooks) => {
  stateOf().hooks ??= hooks;
};
