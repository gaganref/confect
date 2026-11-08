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
 * `A` when every alternative of `A` fits `T`; otherwise a type an alternative
 * that does not fit cannot be assigned to. A callback slot takes an internal
 * host ref that satisfies the slot's contract. Whether a slot may be left
 * `undefined` is `Input`'s to say.
 */
type Check<T, A> = A extends unknown ? Fit<T, A> : never;

/**
 * Distributes over the members of `T`, so a value is checked against the
 * members whose shape it has and fits when it fits one of them.
 */
type Fit<T, A> = T extends Handle
  ? A extends Ref.AnyConfect
    ? A &
        Callback.Check<ContractOf<T>, A> &
        (Ref.GetFunctionVisibility<A> extends "internal"
          ? unknown
          : { readonly callbackMustBeInternal: never })
    : never
  : T extends object
    ? A extends Input<T>
      ? {
          readonly [K in keyof A]: K extends keyof T
            ? Check<T[K], A[K]>
            : never;
        }
      : never
    : A extends T
      ? A
      : never;

type ArgsOf<C> = C extends { readonly init: infer I extends Component.Init }
  ? Ref.Args<I>
  : never;

/**
 * `[C]`, not a bare `C`, so the conditional is not distributive. A distributive
 * one resolves against `Component.Descriptor` while `C` is inferred, drops `A`
 * from the contextual type, and widens inline literals until `A` falls back to
 * its constraint.
 */
type ArgsField<C, A> = [C] extends [
  { readonly init: infer I extends Component.Init },
]
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

/**
 * `B` keeps the bindings as written, so `App.make` can see which backends their
 * entries come from. `[C]` for the reason `ArgsField` gives: a bare `C` widens
 * an inline constant to `string`.
 */
type EnvField<C, B> = [C] extends [{ readonly env: infer E }]
  ? [RequiredKeys<E>] extends [never]
    ? { readonly env?: B & Bindings<E> & NoExtra<B, E> }
    : { readonly env: B & Bindings<E> & NoExtra<B, E> }
  : { readonly env?: never };

type NoExtra<B, E> = { readonly [K in Exclude<keyof B, keyof E>]: never };

/**
 * The client constructor's parameters after the native mount decide whether
 * `options` is absent, optional or required. A client that takes no native
 * mount cannot be mounted. That branch is an object, not `never`, so the
 * literal `name` and `args` beside it keep their types.
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
    : { readonly options: never };

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
 * What a mount was declared with, as written: its HTTP prefix and env bindings.
 */
export interface Declared<
  P extends App.HttpPrefix | undefined = App.HttpPrefix | undefined,
  B = unknown,
> {
  readonly httpPrefix: P;
  readonly env: B;
}

/**
 * A mounted Convex component. Yield it for its client. Its default is the
 * component's client over this mount, and `Effect.provideService` replaces it.
 */
export interface Mount<
  C extends Component.Descriptor,
  Name extends string,
  D extends Declared = Declared,
> extends Context.Reference<Client<C>> {
  readonly [TypeId]: Data<C> & { readonly name: Name };
  readonly "~declared"?: D;
}

export type Any = Mount<Component.Descriptor, string>;

export type NameOf<M> = M extends Mount<any, infer N, any> ? N : never;

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
  const P extends App.HttpPrefix = never,
  const B = {},
>(
  component: C,
  options: {
    readonly name: Name;
    readonly httpPrefix?: P;
  } & EnvField<C, B> &
    ArgsField<C, A> &
    OptionsField<C>,
): Mount<C, Name, Declared<[P] extends [never] ? undefined : P, B>> => {
  const data = { ...(options as object), component } as Data<C> & {
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
  mount: Mount<C, Name, Declared>,
): Data<C> & { readonly name: Name } => mount[TypeId];
