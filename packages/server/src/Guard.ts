export { type Guard, isGuard, make, none } from "@confect/core/Guard";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

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
