export { type Guard, isGuard, make, none } from "@confect/core/Guard";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import { failures } from "./internal/routeFailure.js";

/**
 * Why Confect refused product code's answer: a body past the 1 MiB result cap,
 * a cookie name set twice, a pre-response handler registered on a route path,
 * product code that ended without an answer, or Effect's request state missing
 * from where Confect reads it.
 *
 * @stability unstable
 */
export type Refusal =
  | "bodyOverCap"
  | "repeatedCookie"
  | "preResponseHandler"
  | "unanswered"
  | "requestStateMissing";

/**
 * Why a route request answered a server error, as plain data: product code
 * failed, or Confect refused its answer. It holds nothing of the failure's
 * cause, which is where a value from the request would be.
 *
 * @stability unstable
 */
export type Failure =
  | { readonly _tag: "ProductFailed" }
  | { readonly _tag: "Refused"; readonly reason: Refusal };

/**
 * The failure behind the response a guard's `inner` answered, or none when that
 * response is not a server error. It reads the response `inner` returned, not a
 * copy the guard has since changed.
 *
 * ```ts
 * export const guard = Guard.make(
 *   "frame",
 *   (inner) =>
 *     Effect.gen(function* () {
 *       const response = yield* inner;
 *       const failure = Guard.failure(response);
 *       yield* Effect.log(`answered ${response.status}`, failure);
 *       return response;
 *     }),
 *   { reportsFailures: true },
 * );
 * ```
 *
 * @stability unstable
 */
export const failure = (
  response: HttpServerResponse.HttpServerResponse,
): Option.Option<Failure> => Option.fromUndefinedOr(failures.get(response));

/**
 * Whether the request the guard runs for is an OPTIONS request on the route's
 * path, which the guard owns with or without `Access-Control-Request-Method`.
 *
 * @stability unstable
 */
export const Preflight = Context.Reference<boolean>(
  "@confect/server/Guard/Preflight",
  { defaultValue: () => false },
);

/**
 * A backend serves route specs without a guard.
 *
 * @stability unstable
 */
export class MissingGuard extends Schema.TaggedError<
  MissingGuard,
  { readonly brand: unique symbol }
>()("MissingGuard", { functionPath: Schema.String }) {
  override get message(): string {
    return `Route "${this.functionPath}" needs a guard: pass HttpRouter.make's guard option, or Guard.none to serve routes without admission`;
  }
}

const reflectionProblemNames = [
  "notReflected",
  "mismatched",
  "prefixed",
  "notServed",
] as const;

const reflectionProblems: Record<
  (typeof reflectionProblemNames)[number],
  string
> = {
  notReflected: "is in no api of HttpRouter.make's api list",
  mismatched: "is reflected as another route",
  prefixed: "is registered under a prefix, so it is not served at its path",
  notServed: "is annotated as a route but not registered by Routes.make",
};

/**
 * A route spec's registration and the router's api list disagree, so the router
 * cannot tell every route request apart before it is served.
 *
 * @stability unstable
 */
export class UnreflectedRoute extends Schema.TaggedError<
  UnreflectedRoute,
  { readonly brand: unique symbol }
>()("UnreflectedRoute", {
  functionPath: Schema.String,
  problem: Schema.Literals(reflectionProblemNames),
}) {
  override get message(): string {
    return `Route "${this.functionPath}" ${reflectionProblems[this.problem]}`;
  }
}

/**
 * A plain Convex route, or an explicit OPTIONS or any-method route, could
 * answer a request for a route spec without its guard.
 *
 * @stability unstable
 */
export class RouteShadowed extends Schema.TaggedError<
  RouteShadowed,
  { readonly brand: unique symbol }
>()("RouteShadowed", {
  method: Schema.String,
  path: Schema.String,
  functionPath: Schema.String,
}) {
  override get message(): string {
    return `${this.method} ${this.path} could answer a request for route "${this.functionPath}" before its guard`;
  }
}
