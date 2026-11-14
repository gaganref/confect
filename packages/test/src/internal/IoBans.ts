import * as KernelRefusal from "./KernelRefusal.js";

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
 * While a module loads outside any function, `fetch` and the timers follow the
 * query and mutation rules unless the kernel knows the module has a `"use
 * node"` directive.
 *
 * One rule is the kernel's own: a raw `fetch` in an action, a Node action
 * included, dies with `BackendRefusal` `UndeclaredFetch`, where the binary
 * performs it. Egress goes through a provider port (`Egress.ts`) instead.
 */

import * as Util from "node:util";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import * as HostGlobals from "./HostGlobals.js";

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
  readonly componentPath: string;
  readonly udfPath: string;
}

/**
 * A module the kernel is loading, outside any function.
 */
export interface Loading {
  /**
   * `"node"` for a module the kernel knows has a `"use node"` directive, else
   * `"isolate"`.
   */
  readonly runtime: Runtime;
  readonly componentPath: string;
  readonly modulePath: string;
}

export interface Hooks {
  /**
   * The kernel function running in the caller's async context, if any.
   */
  readonly running: () => Running | undefined;
  /**
   * The module loading in the caller's async context, if any.
   */
  readonly loading: () => Loading | undefined;
  /**
   * End the running function with `error`: it fails with `error` at once,
   * whether or not its handler ever settles, as the binary terminates a
   * function at its next microtask checkpoint, and its later syscalls, calls
   * and provider commands are refused. Outside a function, end the loading
   * module's load with it the same way.
   */
  readonly end: (error: unknown) => void;
  /**
   * Whether the function running in the caller's async context has ended.
   */
  readonly ended: () => boolean;
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
  // Split and joined rather than replaced, so a `$` in the target is no
  // replacement pattern.
  const cause = pipe(
    notAllowed("fetch()"),
    Str.split(url),
    Arr.join(target),
    Str.split(`${target}${search}${hash}`),
    Arr.join(target),
  );
  return new TypeError(
    pipe(cause, Str.includes(target))
      ? cause
      : `fetch to ${target} failed: ${cause}`,
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

/**
 * What a guard checks a call against while a module the isolate runs loads,
 * outside any function: the binary's query and mutation rules. The binary runs
 * a query's or mutation's module top level in that function's environment, so
 * `fetch` rejects and a timer fails it (`start_async_op` in
 * `crates/isolate/src/environment/udf/mod.rs:369`, at the local backend's
 * `cccbade4`). An isolate action's module fails its import on a timer
 * (`require_executing`, `crates/isolate/src/environment/action/phase.rs:470`).
 * Its `fetch` starts its op only after an `await`, once the import is over
 * (`npm-packages/udf-runtime/src/26_fetch.ts:81`), so it succeeds there; the
 * kernel, which loads a module before it knows what it exports, refuses it as
 * for a query, the one place it is stricter. A `"use node"` module imports in
 * Node (`npm-packages/node-executor/src/executor.ts:410`), with Node's I/O.
 */
const isolateLoad = ({ componentPath, modulePath }: Loading): Running => ({
  udfType: "query",
  runtime: "isolate",
  componentPath,
  udfPath: modulePath,
});

/**
 * What a guard checks a call against: the function running, else, for a global
 * that `atLoad` refuses while a module loads, the load of an isolate module.
 */
const callerOf = (state: State, atLoad: boolean): Running | undefined => {
  const running = runningOf(state);
  if (running !== undefined || !atLoad) return running;
  const loading = state.hooks?.loading();
  return loading?.runtime === "isolate" ? isolateLoad(loading) : undefined;
};

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
  const sites = callSites?.(12) ?? [];
  return pipe(
    Arr.findFirst(sites, (site) => site.scriptName !== here),
    Option.exists((caller) => nodeCallers.has(caller.scriptName)),
  );
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

const fetchRule: Rule = (state, running, args) => {
  // As on the binary, the request is built first, so a malformed one rejects
  // with the host's own error.
  let request: Request;
  try {
    request = new HostGlobals.request(
      ...(args as ConstructorParameters<typeof Request>),
    );
  } catch (error) {
    return { answer: Promise.reject(error) };
  }
  if (inTransaction(running)) {
    return { answer: Promise.reject(fetchInTransaction(request.url)) };
  }
  const refusal = KernelRefusal.undeclaredFetch(
    running.componentPath,
    running.udfPath,
    new URL(request.url).host,
  );
  // The action dies whatever its handler catches.
  state.hooks?.end(refusal);
  return { answer: Promise.reject(refusal) };
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

interface Guarded {
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
  /**
   * Whether `rule` also holds while a module the isolate runs loads.
   */
  readonly atLoad: boolean;
}

const guarded: ReadonlyArray<Guarded> = [
  { name: "fetch", rule: fetchRule, absent: false, atLoad: true },
  {
    name: "setTimeout",
    rule: timerRule("setTimeout"),
    promised: promisedTimerRule("setTimeout"),
    absent: false,
    atLoad: true,
  },
  {
    name: "setInterval",
    rule: timerRule("setInterval"),
    promised: promisedTimerRule("setInterval"),
    absent: false,
    atLoad: true,
  },
  {
    name: "setImmediate",
    rule: absentRule("setImmediate"),
    absent: true,
    atLoad: false,
  },
  {
    name: "queueMicrotask",
    rule: absentRule("queueMicrotask"),
    absent: true,
    atLoad: false,
  },
];

const makeGuard = (
  state: State,
  entry: Guarded,
  implementation: () => unknown,
): Fn => {
  const { name, rule, promised, atLoad } = entry;
  function guard(this: unknown, ...args: Array<unknown>): unknown {
    const running = callerOf(state, atLoad);
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
        guardedForm = makeGuard(
          state,
          { ...entry, rule: promised ?? rule },
          () => form,
        );
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
 * module's guards, as convex-test's does once it lays its own over the
 * kernel's. convex-test lays its accessor again whenever another is on top (its
 * `index.ts:3077-3110` at 0.0.67), so guarding it again would add a layer at
 * every function entry while both kinds of world are live.
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
 * The descriptor `name` has on the global's prototype chain, below the global
 * itself, if any: where a replacement moved onto a prototype lives.
 */
const inherited = (
  global: object,
  name: string,
): PropertyDescriptor | undefined => {
  for (
    let prototype: object | null = Object.getPrototypeOf(global) as
      | object
      | null;
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype) as object | null
  ) {
    const found = Object.getOwnPropertyDescriptor(prototype, name);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * Make `name` an own accessor that reads as a guard of the implementation
 * beneath it, unless the own property already reads through a guard: the
 * guard's own accessor, or another library's laid over it, as convex-test lays
 * its own before each of its handlers. The value or accessor it replaces is the
 * first implementation, an own one or, once the own property is gone, the one
 * the prototype chain answers. The own accessor shadows the chain, so no
 * function reaches an inherited replacement. Each implementation has one guard,
 * so a read answers the same function until an assignment, and a reference
 * keeps the implementation it was read with, as a kept reference to the host's
 * function would: convex-test keeps the real `setTimeout` at load to run beside
 * fake timers (its `dist/index.js:2205`). An assignment stores a new
 * implementation beneath, still guarded, and assigning a guard back, as fake
 * timers do when they uninstall, stores the implementation it guards.
 */
/**
 * How installing a guard ended: guarded, a property the kernel cannot redefine,
 * or a redefinition that threw.
 */
type GuardResult = "guarded" | "notConfigurable" | "installFailed";

const guardGlobal = (state: State, entry: Guarded): GuardResult => {
  const { name, absent } = entry;
  const global = globalThis as unknown as Global;
  const own = Object.getOwnPropertyDescriptor(global, name);
  // oxlint-disable-next-line typescript/unbound-method -- Compared by identity, never called.
  if (own?.get !== undefined && state.made.has(own.get)) return "guarded";
  if (own?.get !== undefined && readsThrough(state, own)) return "guarded";
  // A replacement the kernel cannot redefine stays the host's.
  if (own?.configurable === false) return "notConfigurable";
  const found = own ?? inherited(global, name);
  // A global that is gone, own and inherited, leaves a function nothing of the
  // host's to reach.
  if (found === undefined) return "guarded";
  let beneath: PropertyDescriptor = found;
  // Another library's accessor beneath answers per read, so one guard reads
  // through it at each call.
  const throughAccessor = makeGuard(state, entry, () =>
    beneath.get?.call(global),
  );
  const guards = new WeakMap<object, Fn>();
  const guardOf = (implementation: unknown): unknown => {
    if (typeof implementation !== "function") return implementation;
    let guard = guards.get(implementation);
    if (guard === undefined) {
      guard = makeGuard(state, entry, () => implementation);
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
      enumerable: found.enumerable ?? false,
    });
  } catch {
    return "installFailed";
  }
  return "guarded";
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
    const [essence, ...parameters] = pipe(
      this.headers.get("content-type") ?? "",
      Str.split(";"),
      Arr.map((part) => pipe(part, Str.trim, Str.toLowerCase)),
    );
    if (essence !== "multipart/form-data") {
      return Reflect.apply(host, this, []);
    }
    if (!Arr.some(parameters, Str.startsWith("boundary="))) {
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

const consoleMethods = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
] as const;

/**
 * A function that has ended logs nothing more. On the binary its JavaScript
 * stops at termination, and an action's run loop stops once its promise settles
 * (`crates/isolate/src/environment/action/mod.rs:1043-1120`), so no later
 * `console` call reaches `trace` (`:1545-1570`), the only way an action logs.
 * The kernel cannot stop a handler, so it drops the calls an ended function
 * makes. `console` becomes an accessor that reads as a view of the console
 * beneath it, whose logging methods drop an ended function's calls. The console
 * object itself is never written, so a console a test assigns keeps its own
 * methods, spies included, and assigning a view back stores the console it
 * shows. A console a test froze keeps its own methods, which no view can
 * replace, so an ended function's calls to it are not dropped. Like the other
 * guards, a replacement the kernel cannot redefine is `notConfigurable`, a
 * redefinition that throws is `installFailed`, and once the own property is
 * gone the console the prototype chain answers is the one beneath.
 */
const guardConsole = (state: State): GuardResult => {
  const global = globalThis as unknown as Global;
  const own = Object.getOwnPropertyDescriptor(global, "console");
  // oxlint-disable-next-line typescript/unbound-method -- Compared by identity, never called.
  if (own?.get !== undefined && state.made.has(own.get)) return "guarded";
  if (own?.configurable === false) return "notConfigurable";
  const found = own ?? inherited(global, "console");
  if (found === undefined) return "guarded";
  let beneath: unknown =
    "value" in found ? found.value : found.get?.call(global);
  const views = new WeakMap<object, object>();
  const shown = new WeakMap<object, object>();
  const viewOf = (target: unknown): unknown => {
    if (typeof target !== "object" || target === null) return target;
    let view = views.get(target);
    if (view === undefined) {
      const methods = new WeakMap<object, Fn>();
      view = new Proxy(target, {
        get: (on, property) => {
          // A proxy answers a non-configurable property as its target holds
          // it, as a frozen console's are, so such a method is the target's
          // own and its calls cannot be dropped.
          const held = Reflect.getOwnPropertyDescriptor(on, property);
          if (held !== undefined && held.configurable === false) {
            if ("value" in held) {
              if (held.writable === false) return held.value as unknown;
            } else if (held.get === undefined) {
              return undefined;
            }
          }
          const value: unknown = Reflect.get(on, property, on);
          if (
            typeof value !== "function" ||
            !Arr.contains(
              consoleMethods as ReadonlyArray<PropertyKey>,
              property,
            )
          ) {
            return value;
          }
          let logged = methods.get(value);
          if (logged === undefined) {
            const host = value as Fn;
            logged = (...args: Array<unknown>): unknown =>
              state.hooks?.ended() === true
                ? undefined
                : Reflect.apply(host, on, args);
            methods.set(value, logged);
          }
          return logged;
        },
      });
      views.set(target, view);
      shown.set(view, target);
      state.made.add(view);
    }
    return view;
  };
  const get = (): unknown => viewOf(beneath);
  const set = (value: unknown) => {
    beneath =
      typeof value === "object" && value !== null && shown.has(value)
        ? shown.get(value)
        : value;
  };
  state.made.add(get);
  try {
    Object.defineProperty(global, "console", {
      get,
      set,
      configurable: true,
      enumerable: found.enumerable ?? false,
    });
  } catch {
    return "installFailed";
  }
  return "guarded";
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
 * A guarded global the install could not leave guarded, and whether it is a
 * property the kernel cannot redefine.
 */
export interface Unguarded {
  readonly name: string;
  readonly fixed: boolean;
}

/**
 * Guard `fetch`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`,
 * multipart `formData()` and `console`, unless they are already guarded.
 * `@confect/test/setup` calls this before any test module loads, and the kernel
 * again whenever a world opens, a module loads or a function starts, which
 * adopts a global a test redefined, as `vi.stubGlobal` does, as the
 * implementation beneath a fresh guard. It answers the globals it could not
 * guard: a replacement made non-configurable, or one whose redefinition threw.
 * It reads nothing back: the kernel runs {@link readBack} once every install of
 * the boundary has run, the entropy install's included.
 */
export const install = (): ReadonlyArray<Unguarded> => {
  const state = stateOf();
  const results = Arr.map(guarded, (entry) => ({
    name: entry.name,
    result: guardGlobal(state, entry),
  }));
  guardFormData(state, HostGlobals.request.prototype);
  guardFormData(state, HostGlobals.response.prototype);
  const all = [...results, { name: "console", result: guardConsole(state) }];
  return Arr.filterMap(all, ({ name, result }) =>
    result === "guarded"
      ? Result.failVoid
      : Result.succeed({ name, fixed: result === "notConfigurable" }),
  );
};

/**
 * Every guarded global the final read-back and the settlement check read, and
 * what a read of it must answer to need a guard: a function for the I/O guards,
 * an object for `console`, whose guard is a view.
 */
const watched: ReadonlyArray<{
  readonly name: string;
  readonly guardable: (read: unknown) => boolean;
}> = [
  ...Arr.map(guarded, ({ name }) => ({
    name,
    guardable: (read: unknown) => typeof read === "function",
  })),
  {
    name: "console",
    guardable: (read: unknown) => typeof read === "object" && read !== null,
  },
];

/**
 * The I/O guards' part of the one final read-back of every guarded global: each
 * guarded global, read through the prototype chain, must answer a guard. A
 * later install that undid one, as a test's setter on `Math` that replaces
 * `fetch` when the entropy install assigns it does, is answered here, before
 * any user code runs, `console` included: it must answer one of the guard's
 * views. A read that answers nothing to guard, as a test that stubbed the
 * global to `undefined` leaves it, passes.
 */
export const readBack = (): ReadonlyArray<Unguarded> => {
  const state = stateOf();
  return Arr.filterMap(watched, ({ name, guardable }) => {
    const read = readThroughChain(state, name);
    return !guardable(read) || state.made.has(read as object)
      ? Result.failVoid
      : Result.succeed({ name, fixed: false });
  });
};

/**
 * What a read of `name` through the prototype chain answers, whatever function
 * is running.
 */
const readThroughChain = (state: State, name: string): unknown => {
  state.probing = true;
  try {
    return Reflect.get(globalThis, name);
  } catch {
    return undefined;
  } finally {
    state.probing = false;
  }
};

/**
 * Note how the guarded globals read once a function's entry has guarded them.
 * The answer names, when called, each global that no longer reads through to a
 * guard, which a guard could not see: a call made through the replacement
 * reached it unchecked. `console` must still read as one of its guard's views.
 * The global is read as a function would read it, through the prototype chain,
 * so a replacement still in place when the function settles fails, own or
 * inherited, a data property or an accessor: one moved onto a prototype with
 * the own property deleted included. An assignment stores beneath the guard and
 * still reads as one, as does an accessor another library lays over the guard
 * that reads through it, as convex-test's does. Out of scope, as hostile test
 * code: an accessor that runs code to fake the guard at settlement, answering
 * the replacement while the handler runs and the guard by the time it settles,
 * and a replacement removed again before the function settles. A call made
 * through either is neither blocked nor reported.
 */
export const watch = (): (() => ReadonlyArray<string>) => {
  const state = stateOf();
  const global = globalThis as unknown as Global;
  const taken = Arr.map(watched, ({ name, guardable }) => ({
    name,
    guardable,
    present: name in global,
    read: readThroughChain(state, name),
  }));
  const intact = ({
    name,
    guardable,
    present,
    read,
  }: (typeof taken)[number]) => {
    if (!present) return !(name in global);
    const now = readThroughChain(state, name);
    return guardable(now) ? state.made.has(now as object) : now === read;
  };
  return () =>
    pipe(
      taken,
      Arr.filter((entry) => !intact(entry)),
      Arr.map(({ name }) => name),
    );
};

/**
 * Give the guards the kernel's hooks. The first answers for every later one, as
 * with `globalThis.Convex`.
 */
export const bind = (hooks: Hooks) => {
  stateOf().hooks ??= hooks;
};
