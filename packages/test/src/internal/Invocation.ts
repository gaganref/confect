import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionMetadata, RequestMetadata } from "convex/server";
import type * as Context from "effect/Context";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
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
   * from it through `Math.random`, `crypto.getRandomValues` and
   * `crypto.randomUUID`, so Effect's default `Random` draws from it too.
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
    return fresh(bound.world, componentPath, request);
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

const integerArrays = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  BigInt64Array,
  BigUint64Array,
];

const maxRandomBytes = 65_536;

const drawingCrypto = (base: Crypto, random: () => number): Crypto => {
  /**
   * The binary's `getRandomValues`, filled from `random`: it checks its
   * arguments as `udf-runtime/src/00_crypto.ts:28-53` does and the byte limit
   * as `crates/isolate/src/ops/crypto.rs:15-31` does (convex-backend
   * `cccbade4`), with the same errors. It never reads its receiver, so a
   * detached call draws as an attached one.
   */
  function getRandomValues<T extends Parameters<Crypto["getRandomValues"]>[0]>(
    ...args: [array: T]
  ): T {
    const prefix = "Failed to execute 'getRandomValues' on 'Crypto'";
    if (args.length < 1) {
      throw new TypeError(
        `${prefix}: 1 argument required, but only ${args.length} present.`,
      );
    }
    const [array] = args;
    if (
      array === null ||
      !Arr.some(integerArrays, (integers) => array instanceof integers)
    ) {
      throw new DOMException(
        "The provided ArrayBufferView is not an integer array type",
        "TypeMismatchError",
      );
    }
    if (array.byteLength > maxRandomBytes) {
      throw new TypeError(
        `Byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (${maxRandomBytes})`,
      );
    }
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
  /**
   * The binary's `randomUUID`: a version 4 UUID built from 16 bytes of the same
   * generator (`op_crypto_random_uuid`,
   * `crates/isolate/src/ops/crypto.rs:8-12`, through
   * `uuid::Builder::from_random_bytes`, which sets the version and the RFC 4122
   * variant), so it draws from `random` too.
   */
  const randomUUID = (): ReturnType<Crypto["randomUUID"]> => {
    const bytes = getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Arr.join(
      Arr.map(Array.from(bytes), (byte) =>
        Str.padStart(2, "0")(byte.toString(16)),
      ),
      "",
    );
    const part = (start: number, end: number) => Str.slice(start, end)(hex);
    return `${part(0, 8)}-${part(8, 12)}-${part(12, 16)}-${part(16, 20)}-${part(20, 32)}`;
  };
  const drawing: Crypto = new Proxy(base, {
    get: (target, property) => {
      if (property === "getRandomValues") return getRandomValues;
      if (property === "randomUUID") return randomUUID;
      // Crypto's methods and getters need the host object as `this`.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return drawing;
};

/**
 * `Math` and `crypto` over `base`'s, with `Math.random`,
 * `crypto.getRandomValues` and `crypto.randomUUID` drawing from `random` as a
 * pinned handler's do. The kernel loads each module under them, so a draw at
 * module scope comes from the stream the driver supplied.
 */
export const drawingGlobals = (
  base: { readonly Math: Math; readonly crypto: Crypto },
  random: () => number,
): { readonly Math: Math; readonly crypto: Crypto } => ({
  Math: drawingMath(base.Math, random),
  crypto: drawingCrypto(base.crypto, random),
});

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
  // kernel's clock, so `runAfter` schedules on it, and a query that reads it
  // records the read. The bridge leaves it there.
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
  installed[key]?.storage.getStore()?.invocation;
