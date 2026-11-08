import type { ComponentDefinition, EnvDefinition } from "convex/server";
import type { Infer, Validator } from "convex/values";
import type * as HttpApi from "effect/http-api/HttpApi";
import * as Predicate from "effect/Predicate";
import type * as Env from "./Env.js";
import type * as MiddlewareSpec from "./MiddlewareSpec.js";
import * as MountModule from "./Mount.js";

const TypeId = "~@confect/core/App";
const MountTypeId = "~@confect/core/App/Mount";

/**
 * The default export of a Convex component's `convex.config` module.
 */
export type Definition = ComponentDefinition<any, any>;

export type HttpPrefix = `/${string}`;

/**
 * Any `HttpApi`, with its identifier and groups erased.
 */
export type Api = HttpApi.HttpApi<string, any>;

type EnvOf<D extends Definition> = D["__env"];

type IsOptional<V> = V extends Validator<any, "optional", any> ? true : false;

type RequiredKeys<E extends EnvDefinition> = {
  [K in keyof E]: IsOptional<E[K]> extends true ? never : K;
}[keyof E];

type SlotValue<V extends Validator<any, any, any>> = Extract<Infer<V>, string>;

/**
 * What one component env slot accepts: a constant, or an entry whose Convex
 * value fits. A required slot takes only a required entry.
 */
type Slot<V extends Validator<any, any, any>> =
  IsOptional<V> extends true
    ? SlotValue<V> | undefined | Env.Entry<string, any, SlotValue<V>, boolean>
    : SlotValue<V> | Env.Entry<string, any, SlotValue<V>, false>;

export type Bindings<E extends EnvDefinition> = {
  readonly [K in RequiredKeys<E>]: Slot<E[K]>;
} & {
  readonly [K in Exclude<keyof E, RequiredKeys<E>>]?: Slot<E[K]>;
};

type HttpOptions = { readonly httpPrefix?: HttpPrefix };

export type Options<D extends Definition> = HttpOptions &
  ([RequiredKeys<EnvOf<D>>] extends [never]
    ? { readonly env?: Bindings<EnvOf<D>> }
    : { readonly env: Bindings<EnvOf<D>> });

type Exact<D extends Definition, O> = {
  readonly [K in Exclude<keyof O, "env" | "httpPrefix">]: never;
} & (O extends { readonly env: infer B }
  ? {
      readonly env: { readonly [K in Exclude<keyof B, keyof EnvOf<D>>]: never };
    }
  : unknown);

export interface MountData {
  readonly definition: Definition;
  readonly httpPrefix: HttpPrefix | undefined;
  readonly env: Readonly<Record<string, string | Env.AnyEntry | undefined>>;
}

/**
 * A mounted Convex component. `O` keeps the options as written, so {@link make}
 * can see which backends the bound entries come from.
 */
export interface Mount<out D extends Definition, out O> extends MountData {
  readonly [MountTypeId]: { readonly definition: D; readonly options: O };
  readonly httpPrefix: O extends {
    readonly httpPrefix: infer P extends HttpPrefix;
  }
    ? P
    : undefined;
}

export type AnyMount = Mount<Definition, unknown>;

/**
 * Mount a Convex component: the default export of its `convex.config` module,
 * official or Confect-authored. `env` is typed against the component's own
 * `defineComponent({ env })` declaration, so a missing required binding, an
 * optional entry in a required slot, a wrong literal and an unknown slot fail
 * to typecheck.
 */
export function mount<const D extends Definition>(
  definition: D &
    ([RequiredKeys<EnvOf<D>>] extends [never]
      ? unknown
      : "App.mount: this component declares required env; pass { env }"),
): Mount<D, {}>;
export function mount<const D extends Definition, const O extends Options<D>>(
  definition: D,
  options: O & Exact<NoInfer<D>, NoInfer<O>>,
): Mount<D, O>;
export function mount(
  definition: Definition,
  options?: {
    readonly httpPrefix?: HttpPrefix;
    readonly env?: MountData["env"];
  },
): AnyMount {
  return {
    [MountTypeId]: { definition, options },
    definition,
    httpPrefix: options?.httpPrefix,
    env: options?.env ?? {},
    // The overloads above carry the precise types; this body serves both.
  } as AnyMount;
}

type OwnerOf<V> = V extends Env.Entry<infer N, any, any, any> ? N : never;

type Owners<M> =
  M extends Mount<Definition, infer O>
    ? O extends { readonly env: infer B }
      ? { [K in keyof B]: OwnerOf<B[K]> }[keyof B]
      : never
    : M extends MountModule.Mount<any, any, MountModule.Declared<any, infer B>>
      ? { [K in keyof B]: OwnerOf<B[K]> }[keyof B]
      : never;

type OwnedBy<N extends string, M> = {
  readonly [K in keyof M]: [Exclude<Owners<M[K]>, N>] extends [never]
    ? unknown
    : { readonly foreignEnvBackend: Exclude<Owners<M[K]>, N> };
};

export type Kind = "app" | "component";

/**
 * A list of `Mount.make` mounts, or a record of {@link mount} mounts keyed by
 * name.
 */
export type Mounts =
  | ReadonlyArray<MountModule.Any>
  | Readonly<Record<string, AnyMount>>;

export type MountNames<M extends Mounts> =
  M extends ReadonlyArray<infer X> ? MountModule.NameOf<X> : keyof M;

export interface App<
  E extends Env.Any,
  M extends Mounts,
  K extends Kind = Kind,
> {
  readonly [TypeId]: typeof TypeId;
  readonly kind: K;
  readonly env: E;
  readonly components: ReadonlyArray<Definition>;
  readonly mounts: M;
  readonly requiresMiddleware: ReadonlyArray<MiddlewareSpec.AnyMiddlewareSpec>;
}

export type Any = App<Env.Any, Mounts>;

/**
 * Declare a backend, in `confect/app.ts`: its env, the `convex.config`
 * definitions of the Convex components it mounts, and its mounts. Set `kind:
 * "component"` when declaring a component; the default is `"app"`. Codegen
 * rejects a kind that differs from its target, and writes
 * `convex/convex.config.ts` with one `app.use` per mount, in list order, using
 * the listed definition whose `defineComponent` name is the mount's component
 * name. A mount that binds another backend's env entry fails to typecheck.
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
  const M extends Mounts = [],
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

export const isMount = (u: unknown): u is AnyMount =>
  Predicate.hasProperty(u, MountTypeId);

export const env = <A extends Any>(app: A): A["env"] => app.env;

/**
 * The `convex.config` definitions the backend lists, in list order.
 */
export const components = (app: Any): ReadonlyArray<Definition> =>
  app.components;

/**
 * What each mount was declared with, in declaration order: a `Mount.make`
 * mount's data, or a {@link mount} with its name and definition.
 */
export const mounts = (
  app: Any,
): ReadonlyArray<MountModule.Data | (MountData & { readonly name: string })> =>
  Array.isArray(app.mounts)
    ? app.mounts.map(MountModule.data)
    : Object.entries(app.mounts).map(([name, installed]) => ({
        name,
        definition: installed.definition,
        httpPrefix: installed.httpPrefix,
        env: installed.env,
      }));
