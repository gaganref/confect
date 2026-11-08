import { componentsGeneric } from "convex/server";
import * as Context from "effect/Context";
import type * as Schema from "effect/Schema";
import type * as App from "./App.js";
import type * as Component from "./Component.js";
import type * as Env from "./Env.js";

const TypeId = "~@confect/core/Mount";

type IsOptional<S> = S extends { readonly "~type.optionality": "optional" }
  ? true
  : false;

type RequiredKeys<E> = {
  [K in keyof E]: IsOptional<E[K]> extends true ? never : K;
}[keyof E];

type SlotValue<S> = Extract<Schema.Schema.Type<S & Schema.Top>, string>;

/**
 * What one env slot accepts: a constant, or an entry of the host's env whose
 * value fits. A required slot takes only a required entry.
 */
type Slot<S> =
  IsOptional<S> extends true
    ? SlotValue<S> | undefined | Env.Entry<string, any, SlotValue<S>, boolean>
    : SlotValue<S> | Env.Entry<string, any, SlotValue<S>, false>;

type Bindings<E> = { readonly [K in RequiredKeys<E>]: Slot<E[K]> } & {
  readonly [K in Exclude<keyof E, RequiredKeys<E>>]?: Slot<E[K]>;
};

type EnvField<C> = C extends { readonly env: infer E }
  ? [RequiredKeys<E>] extends [never]
    ? { readonly env?: Bindings<E> }
    : { readonly env: Bindings<E> }
  : { readonly env?: never };

/**
 * The client constructor's parameters after the native mount decide whether
 * `options` is absent, optional or required.
 */
type OptionsField<C extends Component.Descriptor> =
  Parameters<C["client"]> extends [unknown, ...infer Rest]
    ? Rest extends []
      ? { readonly options?: never }
      : Rest extends [infer O]
        ? { readonly options: O }
        : Rest extends [options?: infer O]
          ? { readonly options?: Exclude<O, undefined> }
          : never
    : never;

export type Client<C extends Component.Descriptor> = ReturnType<C["client"]>;

export interface Data<C extends Component.Descriptor = Component.Descriptor> {
  readonly component: C;
  readonly name: string;
  readonly httpPrefix?: App.HttpPrefix;
  readonly env?: Readonly<Record<string, string | Env.AnyEntry | undefined>>;
  readonly options?: unknown;
}

/**
 * A mounted Convex component. Yield it for its client. Its default is the
 * component's client over this mount, and `Effect.provideService` replaces it.
 */
export interface Mount<
  C extends Component.Descriptor,
  Name extends string,
> extends Context.Reference<Client<C>> {
  readonly [TypeId]: Data<C> & { readonly name: Name };
}

export type Any = Mount<Component.Descriptor, string>;

/**
 * Mount a Convex component, as Convex's `app.use` does, in the host's
 * `confect/<mount>.ts`. `env` is typed from the component's env slots, and
 * `options` from its client constructor. A handler reaches the client with
 * `yield* BulkEmail`.
 *
 * ```ts
 * export const BulkEmail = Mount.make(Email, {
 *   name: "bulkEmail",
 *   httpPrefix: "/bulk-email",
 *   env: { RESEND_API_KEY: env.BULK_RESEND_KEY },
 * });
 * ```
 */
export const make = <C extends Component.Descriptor, const Name extends string>(
  component: C,
  options: {
    readonly name: Name;
    readonly httpPrefix?: App.HttpPrefix;
  } & EnvField<C> &
    OptionsField<C>,
): Mount<C, Name> => {
  const data = { component, ...(options as object) } as Data<C> & {
    readonly name: Name;
  };
  // The options were checked against the constructor's parameters above.
  const client = component.client as unknown as (
    native: unknown,
    options?: unknown,
  ) => Client<C>;
  const mount = Context.Reference<Client<C>>(`mount/${data.name}`, {
    defaultValue: () => client(componentsGeneric()[data.name], data.options),
  });
  return Object.assign(mount, { [TypeId]: data });
};

/**
 * What a mount was declared with: its component, name, HTTP prefix, env and
 * options.
 */
export const data = <C extends Component.Descriptor, Name extends string>(
  mount: Mount<C, Name>,
): Data<C> & { readonly name: Name } => mount[TypeId];
