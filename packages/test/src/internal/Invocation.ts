import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionMetadata, RequestMetadata } from "convex/server";
import type * as Context from "effect/Context";

/**
 * Four re-executions after the first try. A conflict on attempt 5 exhausts.
 */
export type Attempt = 1 | 2 | 3 | 4 | 5;

/**
 * One test backend. Its `services` reach every invocation it starts on its own,
 * such as a scheduled job.
 */
export interface World {
  readonly name: string;
  readonly services: Context.Context<never>;
}

export interface Invocation {
  readonly world: World;
  readonly componentPath: string;
  readonly attempt: Attempt;
  readonly request: Omit<RequestMetadata, "authToken">;
  readonly services: Context.Context<never>;
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
 * The invocation a handler runs under. A call nested in the bound request joins
 * it at the callee's component path. A job Convex started from a timer set
 * inside the bound request is a request of its own: its scheduled function ID
 * differs, so it gets a fresh record with the world's services.
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
    };
  }
  return componentPath === bound.componentPath
    ? bound
    : { ...bound, componentPath };
};

const make = (): Bridge => {
  const storage = new AsyncLocalStorage<Invocation>();
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
        return storage.run(invocation, () => run(invocation.services));
      });
    },
  };
};

// One bridge per test runtime, so every copy of this module that a test loads
// binds through the store `runHandlerPromise` reads.
const bridge = (): Bridge =>
  ((globalThis as { [key]?: Bridge })[key] ??= make());

/**
 * Run `start` with `invocation` bound. Every registered handler it reaches
 * through convex-test runs with the invocation's services.
 */
export const bind = <A>(
  invocation: Invocation,
  start: () => Promise<A>,
): Promise<A> => bridge().storage.run(invocation, start);

/**
 * The invocation the calling handler runs under, if one is bound.
 */
export const current = (): Invocation | undefined =>
  bridge().storage.getStore();
