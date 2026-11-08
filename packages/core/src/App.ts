import type { ComponentDefinition } from "convex/server";
import type * as HttpApi from "effect/http-api/HttpApi";
import * as Predicate from "effect/Predicate";
import type * as Env from "./Env.js";
import type * as MiddlewareSpec from "./MiddlewareSpec.js";
import * as Mount from "./Mount.js";

const TypeId = "~@confect/core/App";

/**
 * The default export of a Convex component's `convex.config` module.
 */
export type Definition = ComponentDefinition<any, any>;

export type HttpPrefix = `/${string}`;

/**
 * Any `HttpApi`, with its identifier and groups erased.
 */
export type Api = HttpApi.HttpApi<string, any>;

type OwnerOf<V> = V extends Env.Entry<infer N, any, any, any> ? N : never;

type Owners<M> =
  M extends Mount.Mount<any, any, Mount.Declared<any, infer B>>
    ? { [K in keyof B]: OwnerOf<B[K]> }[keyof B]
    : never;

type OwnedBy<N extends string, M> = {
  readonly [K in keyof M]: [Exclude<Owners<M[K]>, N>] extends [never]
    ? unknown
    : { readonly foreignEnvBackend: Exclude<Owners<M[K]>, N> };
};

export type Kind = "app" | "component";

export interface App<
  E extends Env.Any,
  M extends ReadonlyArray<Mount.Any>,
  K extends Kind = Kind,
> {
  readonly [TypeId]: typeof TypeId;
  readonly kind: K;
  readonly env: E;
  readonly components: ReadonlyArray<Definition>;
  readonly mounts: M;
  readonly requiresMiddleware: ReadonlyArray<MiddlewareSpec.AnyMiddlewareSpec>;
}

export type Any = App<Env.Any, ReadonlyArray<Mount.Any>>;

/**
 * Declare a backend, in `confect/app.ts`: its env, the `convex.config`
 * definitions of the Convex components it mounts, and its mounts. Set `kind:
 * "component"` when declaring a component; the default is `"app"`. Codegen
 * rejects a kind that differs from its target, and writes
 * `convex/convex.config.ts` with one `app.use` per mount, in list order, using
 * the definition whose `defineComponent` name is the mount's component name. A
 * mount that binds another backend's env entry fails to typecheck.
 *
 * ```ts
 * import email from "@englever/email/convex.config";
 * import workpool from "@convex-dev/workpool/convex.config";
 *
 * export default App.make({
 *   env,
 *   components: [email, workpool],
 *   mounts: [BulkEmail, TransactionalEmail, ImportsPool],
 * });
 * ```
 */
export const make = <
  const E extends Env.Any,
  const M extends ReadonlyArray<Mount.Any> = [],
  const K extends Kind = "app",
>(
  options: {
    readonly env: E;
    readonly requiresMiddleware?: ReadonlyArray<MiddlewareSpec.AnyMiddlewareSpec>;
    readonly components?: ReadonlyArray<Definition>;
    readonly mounts?: M & OwnedBy<NoInfer<Env.Name<E>>, NoInfer<M>>;
  } & ([K] extends ["app"] ? { readonly kind?: K } : { readonly kind: K }),
): App<E, M, K> => ({
  [TypeId]: TypeId,
  kind: options.kind ?? ("app" as K),
  env: options.env,
  components: options.components ?? [],
  mounts: options.mounts ?? ([] as unknown as M),
  requiresMiddleware: options.requiresMiddleware ?? [],
});

export const isApp = (u: unknown): u is Any =>
  Predicate.hasProperty(u, TypeId) &&
  u[TypeId] === TypeId &&
  Predicate.hasProperty(u, "kind") &&
  (u.kind === "app" || u.kind === "component");

export const env = <A extends Any>(app: A): A["env"] => app.env;

/**
 * The `convex.config` definitions the backend lists, in list order.
 */
export const components = (app: Any): ReadonlyArray<Definition> =>
  app.components;

/**
 * What each mount was declared with, in list order.
 */
export const mounts = (app: Any): ReadonlyArray<Mount.Data> =>
  app.mounts.map(Mount.data);
