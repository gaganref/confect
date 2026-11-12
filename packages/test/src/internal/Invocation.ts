import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionMetadata, RequestMetadata } from "convex/server";
import type * as Context from "effect/Context";
import * as Clock from "./Clock.js";

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
   * starts on its own pins its start time from one reading. A bound action's
   * `Date` reads it live.
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
   * The start time in epoch milliseconds. Every query or mutation of the
   * invocation reads it from `Date.now()` and `new Date()`, so Effect's default
   * `Clock` reads it too. An action reads its world's clock instead, as it
   * runs, and a query or mutation an action calls starts at the action's time
   * then.
   */
  readonly startedAt: number;
  /**
   * The random stream, uniform on [0, 1). Every handler of the invocation draws
   * from it through `Math.random` and `crypto.getRandomValues`, so Effect's
   * default `Random` draws from it too.
   */
  readonly random: () => number;
}

type FunctionType = "query" | "mutation" | "action";

/**
 * The invocation a handler runs under, and the type of the function it runs.
 * Test code that binds an invocation runs no function, so it has no type.
 */
interface Running {
  readonly invocation: Invocation;
  readonly functionType: FunctionType | undefined;
}

/**
 * What `runHandlerPromise` in `@confect/server` reads from `globalThis` under
 * the same key. `start` answers `undefined` when no invocation is bound.
 */
interface Bridge {
  readonly storage: AsyncLocalStorage<Running>;
  readonly start: <A>(
    meta: {
      readonly getFunctionMetadata: () => Promise<FunctionMetadata>;
      readonly getRequestMetadata?: () => Promise<RequestMetadata>;
    },
    run: (services: Context.Context<never>) => Promise<A>,
    functionType: FunctionType,
  ) => Promise<A> | undefined;
}

const key = Symbol.for("@confect/test/Invocation");

/**
 * The invocation a function of `functionType` called from `running` joins. A
 * query or mutation an action calls is a transaction of its own, so it starts
 * at the world's time when it begins. Any other call shares its caller's
 * start.
 */
const caller = (running: Running, functionType: FunctionType): Invocation =>
  running.functionType === "action" && functionType !== "action"
    ? { ...running.invocation, startedAt: running.invocation.world.clock() }
    : running.invocation;

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
    const { ip, userAgent, requestId, scheduledFunctionId } = request;
    return {
      world: bound.world,
      componentPath,
      attempt: 1,
      request: { ip, userAgent, requestId, scheduledFunctionId },
      services: bound.world.services,
      startedAt: bound.world.clock(),
      random: bound.world.random,
    };
  }
  return componentPath === bound.componentPath
    ? bound
    : { ...bound, componentPath };
};

/**
 * What `Date` answers for a function of `functionType` under `invocation`: a
 * query's or mutation's start, or the world's clock as it runs in an action.
 */
const clockOf = (
  invocation: Invocation,
  functionType: FunctionType,
): (() => number) =>
  functionType === "action"
    ? invocation.world.clock
    : () => invocation.startedAt;

const pinnedDate = (
  base: DateConstructor,
  now: () => number,
): DateConstructor =>
  new Proxy(base, {
    get: (target, property, receiver) =>
      property === "now" ? now : Reflect.get(target, property, receiver),
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
    apply: () => new base(now()).toString(),
  });

const drawingMath = (base: Math, random: () => number): Math =>
  new Proxy(base, {
    get: (target, property, receiver) =>
      property === "random" ? random : Reflect.get(target, property, receiver),
  });

const drawingCrypto = (base: Crypto, random: () => number): Crypto => {
  function getRandomValues<T extends Parameters<Crypto["getRandomValues"]>[0]>(
    this: unknown,
    array: T,
  ): T {
    // The host call checks the receiver and the argument and throws the host's
    // errors, so a detached call fails as it does in production.
    // oxlint-disable-next-line typescript/unbound-method -- Applied with the caller's receiver.
    Reflect.apply(base.getRandomValues, this === drawing ? base : this, [
      array,
    ]);
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
  }
  const drawing: Crypto = new Proxy(base, {
    get: (target, property) => {
      if (property === "getRandomValues") return getRandomValues;
      // Crypto's methods and getters need the host object as `this`.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return drawing;
};

/**
 * Point the calling handler's `Date`, `Math` and `crypto` at `invocation`, its
 * `Date` through {@link clockOf}. convex-test gives each handler call its own
 * copy of these globals, and an assignment inside a handler lands in that copy
 * only, so overlapping handlers and the handler's own nested calls keep
 * theirs.
 *
 * `outside` reads in the test's own async context. Where the handler has no
 * copy, an assignment either throws or reaches test code, so `pin` puts back
 * each global that reached it and throws.
 */
const pin = (
  invocation: Invocation,
  functionType: FunctionType,
  outside: <R>(read: () => R) => R,
): void => {
  const host = globalThis;
  const previous = { Date: host.Date, Math: host.Math, crypto: host.crypto };
  // On the kernel, `Date` already answers the running function's time on the
  // kernel's clock, and a query that reads it records the read. The bridge
  // leaves it there.
  const kernelDate = Clock.answersInvocation(previous.Date);
  const pinned = {
    Date: kernelDate
      ? previous.Date
      : pinnedDate(previous.Date, clockOf(invocation, functionType)),
    Math: drawingMath(previous.Math, invocation.random),
    crypto: drawingCrypto(previous.crypto, invocation.random),
  };
  try {
    if (!kernelDate) host.Date = pinned.Date;
    host.Math = pinned.Math;
    host.crypto = pinned.crypto;
  } catch {
    // A global without a per-handler copy can be read-only. The check below
    // refuses the handler.
  }
  const reached = outside(() => ({
    Date: !kernelDate && host.Date === pinned.Date,
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
  const storage = new AsyncLocalStorage<Running>();
  // Taken at the first `bind`, which test code calls outside any handler, so
  // it reads the test environment's globals.
  const outside = AsyncLocalStorage.snapshot();
  return {
    storage,
    start: (meta, run, functionType) => {
      const running = storage.getStore();
      if (running === undefined) return undefined;
      return Promise.all([
        meta.getFunctionMetadata(),
        meta.getRequestMetadata?.(),
      ]).then(([{ componentPath }, request]) => {
        const invocation = resolve(
          caller(running, functionType),
          componentPath,
          request,
        );
        pin(invocation, functionType, outside);
        return storage.run({ invocation, functionType }, () =>
          run(invocation.services),
        );
      });
    },
  };
};

// One bridge per test runtime, so every copy of this module that a test loads
// binds through the store `runHandlerPromise` reads.
const installed = globalThis as { [key]?: Bridge };

/**
 * Run `start` with `invocation` bound. Every registered handler it reaches
 * through convex-test runs with the invocation's services, clock and random
 * stream.
 */
export const bind = <A>(
  invocation: Invocation,
  start: () => Promise<A>,
): Promise<A> =>
  (installed[key] ??= make()).storage.run(
    { invocation, functionType: undefined },
    start,
  );

/**
 * The invocation the calling handler runs under, if one is bound.
 */
export const current = (): Invocation | undefined =>
  installed[key]?.storage.getStore()?.invocation;
