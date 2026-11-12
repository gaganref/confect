import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionMetadata, RequestMetadata } from "convex/server";
import type * as Context from "effect/Context";

/**
 * Four re-executions after the first try. A conflict on attempt 5 exhausts.
 */
export type Attempt = 1 | 2 | 3 | 4 | 5;

/**
 * One test backend. Its `services`, `clock` and `random` reach every invocation
 * it starts on its own, such as a scheduled job.
 */
export interface World {
  readonly name: string;
  readonly services: Context.Context<never>;
  /**
   * The world's controlled clock in epoch milliseconds. An invocation the world
   * starts on its own pins its start time from one reading.
   */
  readonly clock: () => number;
  /**
   * The random stream, uniform on [0, 1), that an invocation the world starts
   * on its own draws from.
   */
  readonly random: () => number;
}

export interface Invocation {
  readonly world: World;
  readonly componentPath: string;
  readonly attempt: Attempt;
  readonly request: Omit<RequestMetadata, "authToken">;
  readonly services: Context.Context<never>;
  /**
   * The start time in epoch milliseconds. Every handler of the invocation reads
   * it from `Date.now()` and `new Date()`, so Effect's default `Clock` reads it
   * too.
   */
  readonly startedAt: number;
  /**
   * The random stream, uniform on [0, 1). Every handler of the invocation draws
   * from it through `Math.random` and `crypto.getRandomValues`, so Effect's
   * default `Random` draws from it too.
   */
  readonly random: () => number;
}

/**
 * What `runHandlerPromise` in `@confect/server` reads from `globalThis` under
 * the same key. `start` answers `undefined` when no invocation is bound.
 */
interface Bridge {
  readonly storage: AsyncLocalStorage<Invocation>;
  readonly start: <A>(
    meta: {
      readonly getFunctionMetadata: () => Promise<FunctionMetadata>;
      readonly getRequestMetadata?: () => Promise<RequestMetadata>;
    },
    run: (services: Context.Context<never>) => Promise<A>,
  ) => Promise<A> | undefined;
}

const key = Symbol.for("@confect/test/Invocation");

/**
 * A fresh invocation of `world` for a request of its own, as an action or a
 * scheduled job starts: attempt 1, the world's services and random stream, and
 * a start time read from the world's clock.
 */
export const fresh = (
  world: World,
  componentPath: string,
  { ip, userAgent, requestId, scheduledFunctionId }: Invocation["request"],
): Invocation => ({
  world,
  componentPath,
  attempt: 1,
  request: { ip, userAgent, requestId, scheduledFunctionId },
  services: world.services,
  startedAt: world.clock(),
  random: world.random,
});

/**
 * The invocation a handler runs under. A call nested in the bound request joins
 * it at the callee's component path. A job Convex started from a timer set
 * inside the bound request is a request of its own: its scheduled function ID
 * differs, so it gets a fresh record with the world's services, clock and
 * random stream.
 */
const resolve = (
  bound: Invocation,
  componentPath: string,
  request: RequestMetadata | undefined,
): Invocation => {
  if (
    request !== undefined &&
    request.scheduledFunctionId !== bound.request.scheduledFunctionId
  ) {
    return fresh(bound.world, componentPath, request);
  }
  return componentPath === bound.componentPath
    ? bound
    : { ...bound, componentPath };
};

const pinnedDate = (base: DateConstructor, millis: number): DateConstructor => {
  const now = () => millis;
  return new Proxy(base, {
    get: (target, property, receiver) =>
      property === "now" ? now : Reflect.get(target, property, receiver),
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [millis] : args, newTarget),
    apply: () => new base(millis).toString(),
  });
};

const drawingMath = (base: Math, random: () => number): Math =>
  new Proxy(base, {
    get: (target, property, receiver) =>
      property === "random" ? random : Reflect.get(target, property, receiver),
  });

const drawingCrypto = (base: Crypto, random: () => number): Crypto => {
  const getRandomValues = <T extends Parameters<Crypto["getRandomValues"]>[0]>(
    array: T,
  ): T => {
    // The host call checks the argument and throws the host's errors.
    base.getRandomValues(array);
    if (array === null) return array;
    const bytes = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength,
    );
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(random() * 256);
    }
    return array;
  };
  return new Proxy(base, {
    get: (target, property) => {
      if (property === "getRandomValues") return getRandomValues;
      // Crypto's methods and getters need the host object as `this`.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/**
 * Point the calling handler's `Date`, `Math` and `crypto` at `invocation`.
 * convex-test gives each handler call its own copy of these globals, and an
 * assignment inside a handler lands in that copy only, so overlapping handlers
 * and the handler's own nested calls keep theirs.
 *
 * `outside` reads in the test's own async context. Where the handler has no
 * copy, an assignment either throws or reaches test code, so `pin` puts back
 * each global that reached it and throws.
 */
const pin = (
  invocation: Invocation,
  outside: <R>(read: () => R) => R,
): void => {
  const host = globalThis;
  const previous = { Date: host.Date, Math: host.Math, crypto: host.crypto };
  const pinned = {
    Date: pinnedDate(previous.Date, invocation.startedAt),
    Math: drawingMath(previous.Math, invocation.random),
    crypto: drawingCrypto(previous.crypto, invocation.random),
  };
  try {
    host.Date = pinned.Date;
    host.Math = pinned.Math;
    host.crypto = pinned.crypto;
  } catch {
    // A global without a per-handler copy can be read-only. The check below
    // refuses the handler.
  }
  const reached = outside(() => ({
    Date: host.Date === pinned.Date,
    Math: host.Math === pinned.Math,
    crypto: host.crypto === pinned.crypto,
  }));
  if (
    host.Date === pinned.Date &&
    host.Math === pinned.Math &&
    host.crypto === pinned.crypto &&
    !reached.Date &&
    !reached.Math &&
    !reached.crypto
  ) {
    return;
  }
  if (reached.Date) host.Date = previous.Date;
  if (reached.Math) host.Math = previous.Math;
  if (reached.crypto) host.crypto = previous.crypto;
  throw new Error(
    "@confect/test cannot pin this handler's Date, Math and crypto: it runs without convex-test's per-handler globals, so pinning would change them for every caller",
  );
};

const make = (): Bridge => {
  const storage = new AsyncLocalStorage<Invocation>();
  // Taken at the first `bind`, which test code calls outside any handler, so
  // it reads the test environment's globals.
  const outside = AsyncLocalStorage.snapshot();
  return {
    storage,
    start: (meta, run) => {
      const bound = storage.getStore();
      if (bound === undefined) return undefined;
      return Promise.all([
        meta.getFunctionMetadata(),
        meta.getRequestMetadata?.(),
      ]).then(([{ componentPath }, request]) => {
        const invocation = resolve(bound, componentPath, request);
        pin(invocation, outside);
        return storage.run(invocation, () => run(invocation.services));
      });
    },
  };
};

// One bridge per test runtime, so every copy of this module that a test loads
// binds through the store `runHandlerPromise` reads.
const installed = globalThis as { [key]?: Bridge };

/**
 * Run `start` with `invocation` bound. Every registered handler it reaches
 * through convex-test runs with the invocation's services, start time and
 * random stream.
 */
export const bind = <A>(
  invocation: Invocation,
  start: () => Promise<A>,
): Promise<A> => (installed[key] ??= make()).storage.run(invocation, start);

/**
 * Run `start` with no invocation bound, so every registered handler it reaches
 * keeps its production runtime, whatever the caller has bound.
 */
export const unbound = <A>(start: () => Promise<A>): Promise<A> => {
  const bridge = installed[key];
  return bridge === undefined ? start() : bridge.storage.exit(start);
};

/**
 * The invocation the calling handler runs under, if one is bound.
 */
export const current = (): Invocation | undefined =>
  installed[key]?.storage.getStore();
