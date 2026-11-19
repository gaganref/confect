import * as Predicate from "effect/Predicate";
import type * as HttpMiddleware from "effect/http/HttpMiddleware";

const TypeId = "~@confect/core/Guard";

/**
 * The middleware a backend runs first on every route path, outside every
 * product middleware, with `Routes.Route` and `Guard.Preflight` provided. It is
 * a plain Effect `HttpMiddleware`; its `inner` never fails, since a failure
 * inside has already become Effect's response for it. `name` labels the guard
 * for codegen, so a framework can check which guard a backend declares.
 * `reportsFailures` says whether the guard logs its route requests' server
 * failures itself, in place of Confect.
 *
 * @stability unstable
 */
export interface Guard extends HttpMiddleware.HttpMiddleware {
  readonly [TypeId]: typeof TypeId;
  readonly name: string;
  readonly reportsFailures: boolean;
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
 * By default Confect logs a route request's server failure before the guard
 * sees its 500. With `reportsFailures: true` Confect logs nothing on the
 * guard's routes, its own refusals included, and the guard reads the failure as
 * data with `Guard.failure(response)` to write its own line.
 *
 * @stability unstable
 */
export const make = (
  name: string,
  middleware: HttpMiddleware.HttpMiddleware,
  options?: { readonly reportsFailures?: boolean },
): Guard =>
  Object.defineProperties(
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- An HttpMiddleware's result channels are Effect's own erased any.
    ((inner) => middleware(inner)) as HttpMiddleware.HttpMiddleware,
    {
      [TypeId]: { value: TypeId },
      name: { value: name },
      reportsFailures: { value: options?.reportsFailures === true },
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
