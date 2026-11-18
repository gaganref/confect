import * as Predicate from "effect/Predicate";
import type * as HttpMiddleware from "effect/http/HttpMiddleware";

const TypeId = "~@confect/core/Guard";

/**
 * The middleware a backend runs first on every route path, outside every
 * product middleware, with `Routes.Route` and `Guard.Preflight` provided. It is
 * a plain Effect `HttpMiddleware`; its `inner` never fails, since a failure
 * inside has already become Effect's response for it. `name` labels the guard
 * for codegen, so a framework can check which guard a backend declares.
 *
 * @stability unstable
 */
export interface Guard extends HttpMiddleware.HttpMiddleware {
  readonly [TypeId]: typeof TypeId;
  readonly name: string;
}

/**
 * Name a middleware as a backend's guard.
 *
 * ```ts
 * export const guard = Guard.make("frame", (inner) =>
 *   Effect.gen(function* () {
 *     const { spec } = yield* Routes.Route;
 *     if (yield* Guard.Preflight) return preflightResponse(spec);
 *     return yield* inner;
 *   }),
 * );
 * ```
 *
 * @stability unstable
 */
export const make = (
  name: string,
  middleware: HttpMiddleware.HttpMiddleware,
): Guard =>
  Object.defineProperties(
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- An HttpMiddleware's result channels are Effect's own erased any.
    ((inner) => middleware(inner)) as HttpMiddleware.HttpMiddleware,
    {
      [TypeId]: { value: TypeId },
      name: { value: name },
    },
  ) as Guard;

/**
 * The explicit opt-out: routes run with the action services and no admission.
 * It is never a default or an authorization policy.
 *
 * @stability unstable
 */
export const none: Guard = make("none", (inner) => inner);

/**
 * @stability unstable
 */
export const isGuard = (u: unknown): u is Guard =>
  Predicate.hasProperty(u, TypeId);
