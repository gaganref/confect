import type { ComponentDefinition, EnvDefinition } from "convex/server";
import type { Infer, Validator } from "convex/values";
import type * as HttpApi from "effect/http-api/HttpApi";
import * as Predicate from "effect/Predicate";
import type * as Env from "./Env";

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

type HttpOptions =
  | { readonly httpPrefix?: never; readonly api?: never }
  | { readonly httpPrefix: HttpPrefix; readonly api?: Api };

export type Options<D extends Definition> = HttpOptions &
  ([RequiredKeys<EnvOf<D>>] extends [never]
    ? { readonly env?: Bindings<EnvOf<D>> }
    : { readonly env: Bindings<EnvOf<D>> });

type Exact<D extends Definition, O> = {
  readonly [K in Exclude<keyof O, "env" | "httpPrefix" | "api">]: never;
} & (O extends { readonly env: infer B }
  ? {
      readonly env: { readonly [K in Exclude<keyof B, keyof EnvOf<D>>]: never };
    }
  : unknown);

export interface MountData {
  readonly definition: Definition;
  readonly httpPrefix: HttpPrefix | undefined;
  readonly api: Api | undefined;
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
 * to typecheck. `api` is the component's `HttpApi`, for route checks.
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
    readonly api?: Api;
    readonly env?: MountData["env"];
  },
): AnyMount {
  return {
    [MountTypeId]: { definition, options },
    definition,
    httpPrefix: options?.httpPrefix,
    api: options?.api,
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
    : never;

type OwnedBy<N extends string, M> = {
  readonly [K in keyof M]: [Exclude<Owners<M[K]>, N>] extends [never]
    ? unknown
    : { readonly foreignEnvBackend: Exclude<Owners<M[K]>, N> };
};

export type Kind = "app" | "component";

export interface App<
  E extends Env.Any,
  M extends Readonly<Record<string, AnyMount>>,
  K extends Kind = Kind,
> {
  readonly [TypeId]: typeof TypeId;
  readonly kind: K;
  readonly env: E;
  readonly mounts: M;
}

export type Any = App<Env.Any, Readonly<Record<string, AnyMount>>>;

/**
 * Declare a backend, in `confect/app.ts`: its env and its mounted Convex
 * components by name. Set `kind: "component"` when declaring a component; the
 * default is `"app"`. Codegen rejects a kind that differs from its target.
 * Codegen writes `convex/convex.config.ts` from it. A mount that binds another
 * backend's env entry fails to typecheck.
 *
 * ```ts
 * export default App.make({
 *   env,
 *   mounts: {
 *     email: App.mount(email, {
 *       httpPrefix: "/email",
 *       env: { FROM: env.EMAIL_FROM, KEY: env.RESEND_API_KEY },
 *     }),
 *     importsPool: App.mount(workpool),
 *   },
 * });
 * ```
 */
export const make = <
  const E extends Env.Any,
  const M extends Readonly<Record<string, AnyMount>> = {},
  const K extends Kind = "app",
>(
  options: {
    readonly env: E;
    readonly mounts?: M & OwnedBy<NoInfer<Env.Name<E>>, NoInfer<M>>;
  } & ([K] extends ["app"] ? { readonly kind?: K } : { readonly kind: K }),
): App<E, M, K> => ({
  [TypeId]: TypeId,
  kind: options.kind ?? ("app" as K),
  env: options.env,
  mounts: options.mounts ?? ({} as M),
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
 * Every mount with its name, in declaration order.
 */
export const mounts = (
  app: Any,
): ReadonlyArray<MountData & { readonly name: string }> =>
  Object.entries(app.mounts).map(([name, installed]) => ({
    name,
    definition: installed.definition,
    httpPrefix: installed.httpPrefix,
    api: installed.api,
    env: installed.env,
  }));
