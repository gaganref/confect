import type * as FunctionSpec from "@confect/core/FunctionSpec";

export interface RouteIdentity {
  readonly functionPath: string;
  readonly spec: FunctionSpec.AnyHttpAction;
}

/**
 * The route spec each registration `Routes.make` adds serves, keyed by the
 * registration object the router receives. It carries a spec's identity into
 * the router whether or not the router's api list names its api.
 */
export const identities = new WeakMap<object, RouteIdentity>();
