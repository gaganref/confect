import { componentsGeneric } from "convex/server";
import * as Context from "effect/Context";
import type * as Schema from "effect/Schema";
import type * as App from "./App.js";
import type * as Callback from "./Callback.js";
import type * as Component from "./Component.js";
import type * as Env from "./Env.js";
import type * as Ref from "./Ref.js";

const TypeId = "~@confect/core/Mount";

type Handle = Ref.AnyConfect & {
  readonly "~@confect/core/Callback/Handle": Callback.Id;
};

type ContractOf<H extends Handle> = Callback.Contract<
  H["~@confect/core/Callback/Handle"],
  Ref.GetFunctionType<H>,
  H["args"]["fields"],
  H["returns"],
  Extract<NonNullable<H["error"]>, Schema.Top>
>;

/**
 * What a mount passes for `init`'s args: the same shape, with a host ref in
 * each callback slot.
 */
type Input<T> = T extends Handle
  ? Ref.AnyConfect
  : T extends object
    ? { readonly [K in keyof T]: Input<T[K]> }
    : T;

/**
 * `unknown` when the args fit; otherwise the first refusal. A callback slot
 * takes an internal host ref that satisfies the slot's contract.
 */
type Check<T, A> =
  NonNullable<T> extends Handle
    ? NonNullable<A> extends Ref.AnyConfect
      ? Callback.Check<
          ContractOf<Extract<NonNullable<T>, Handle>>,
          NonNullable<A>
        > &
          (Ref.GetFunctionVisibility<NonNullable<A>> extends "internal"
            ? unknown
            : { readonly callbackMustBeInternal: never })
      : never
    : NonNullable<T> extends object
      ? {
          readonly [K in keyof A]: K extends keyof T
            ? Check<T[K], A[K]>
            : never;
        }
      : unknown;

type ArgsOf<C> = C extends { readonly init: infer I extends Component.Init }
  ? Ref.Args<I>
  : never;

type ArgsField<C, A> = C extends {
  readonly init: infer I extends Component.Init;
}
  ? { readonly args: A & NoInfer<Check<Ref.Args<I>, A>> }
  : { readonly args?: never };

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
  readonly args?: unknown;
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
 * `confect/<mount>.ts`. `args` is typed from the component's `init`, `env` from
 * its env slots, and `options` from its client constructor. A handler reaches
 * the client with `yield* BulkEmail`.
 *
 * ```ts
 * export const BulkEmail = Mount.make(Email, {
 *   name: "bulkEmail",
 *   httpPrefix: "/bulk-email",
 *   env: { RESEND_API_KEY: env.BULK_RESEND_KEY },
 *   args: {
 *     fromName: "School office",
 *     onEvent: refs.internal.circulars.onEmailEvent,
 *   },
 * });
 * ```
 */
export const make = <
  C extends Component.Descriptor,
  const Name extends string,
  const A extends Input<ArgsOf<C>>,
>(
  component: C,
  options: {
    readonly name: Name;
    readonly httpPrefix?: App.HttpPrefix;
  } & EnvField<C> &
    ArgsField<C, A> &
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
 * What a mount was declared with: its component, name, HTTP prefix, env, args
 * and options.
 */
export const data = <C extends Component.Descriptor, Name extends string>(
  mount: Mount<C, Name>,
): Data<C> & { readonly name: Name } => mount[TypeId];
