import * as Config from "effect/Config";
import type * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Redacted from "effect/Redacted";

const TypeId = "~@confect/core/Env";
const EntryTypeId = "~@confect/core/Env/Entry";

/**
 * What one environment variable is, as plain data. Codegen renders it as a
 * Convex validator in `convex.config.ts` and copies it into the generated
 * manifest unchanged.
 */
export type Descriptor =
  | { readonly kind: "string"; readonly optional: boolean }
  | { readonly kind: "secret"; readonly optional: boolean }
  | {
      readonly kind: "literals";
      readonly values: readonly [string, ...Array<string>];
      readonly optional: boolean;
    };

/**
 * An entry before {@link make} names it. `A` is what a handler reads, `Value` is
 * the string Convex stores, and `Optional` decides which component env slots
 * the entry may be bound to.
 */
export interface Field<
  out A,
  out Value extends string,
  out Optional extends boolean,
> {
  readonly descriptor: Descriptor;
  readonly config: (key: string) => Config.Config<A>;
  readonly "~value"?: Value;
  readonly "~optional"?: Optional;
}

export type AnyField = Field<any, string, boolean>;

/**
 * A named entry of a backend's env: an Effect `Config` that a handler yields,
 * which also records the backend it belongs to. A mount binding accepts an
 * entry only when its backend, Convex value and optionality fit the slot.
 */
export interface Entry<
  out Backend extends string,
  out A,
  out Value extends string,
  out Optional extends boolean,
> extends Config.Config<A> {
  readonly [EntryTypeId]: {
    readonly backend: Backend;
    readonly key: string;
    readonly descriptor: Descriptor;
    readonly optional: Optional;
    readonly "~value"?: Value;
  };
}

export type AnyEntry = Entry<string, any, string, boolean>;

type Entries<
  Backend extends string,
  Fields extends Record<string, AnyField>,
> = {
  readonly [K in keyof Fields]: Fields[K] extends Field<
    infer A,
    infer Value,
    infer Optional
  >
    ? Entry<Backend, A, Value, Optional>
    : never;
};

/**
 * A backend's environment: its entries as properties, and its name under a
 * namespaced key no entry can collide with.
 */
export type Env<
  Backend extends string,
  Fields extends Record<string, AnyField>,
> = Entries<Backend, Fields> & {
  readonly [TypeId]: {
    readonly name: Backend;
    readonly entries: ReadonlyArray<readonly [string, AnyEntry]>;
  };
};

export interface Any {
  readonly [TypeId]: {
    readonly name: string;
    readonly entries: ReadonlyArray<readonly [string, AnyEntry]>;
  };
}

export type Name<E extends Any> = E[typeof TypeId]["name"];

/**
 * A plain string variable.
 */
export const string = (): Field<string, string, false> => ({
  descriptor: { kind: "string", optional: false },
  config: (key) => Config.String(key),
});

/**
 * A string variable read as `Redacted`, so it never prints in logs.
 */
export const secret = (): Field<Redacted.Redacted<string>, string, false> => ({
  descriptor: { kind: "secret", optional: false },
  config: (key) => Config.Redacted(key),
});

/**
 * A variable that must be one of the given strings.
 */
export const literals = <const L extends readonly [string, ...Array<string>]>(
  values: L,
): Field<L[number], L[number], false> => ({
  descriptor: { kind: "literals", values, optional: false },
  config: (key) => Config.Literals(values, key),
});

/**
 * A variable that may be unset; a handler reads it as an `Option`.
 */
export const optional = <A, Value extends string>(
  field: Field<A, Value, false>,
): Field<Option.Option<A>, Value, true> => ({
  descriptor: { ...field.descriptor, optional: true },
  config: (key) => Config.option(field.config(key)),
});

type LiteralName<N extends string> = string extends N ? never : N;

/**
 * Declare a backend's environment variables, once per backend, in
 * `confect/env.ts`. The name is the backend's identity: an entry of one backend
 * cannot be bound in another backend's mounts, and a Confect-authored
 * component's name is its Convex component name.
 *
 * ```ts
 * export default Env.make("tenant", {
 *   EMAIL_FROM: Env.string(),
 *   RESEND_API_KEY: Env.secret(),
 *   EMAIL_TRANSPORT: Env.literals(["resend", "log"]),
 *   PLATFORM_URL: Env.optional(Env.string()),
 * });
 * ```
 */
export const make = <
  const N extends string,
  const Fields extends Record<string, AnyField>,
>(
  name: LiteralName<N>,
  fields: Fields,
): Env<N, Fields> => {
  const entries = Object.entries(fields).map(
    ([key, field]) =>
      [
        key,
        Object.assign(field.config(key), {
          [EntryTypeId]: {
            backend: name,
            key,
            descriptor: field.descriptor,
            optional: field.descriptor.optional,
          },
        }),
      ] as const,
  );
  // The entries are built from `fields` key by key, which TypeScript cannot
  // correlate through `Object.fromEntries`.
  return {
    ...Object.fromEntries(entries),
    [TypeId]: { name, entries },
  } as unknown as Env<N, Fields>;
};

export const isEnv = (u: unknown): u is Any => Predicate.hasProperty(u, TypeId);

export const isEntry = (u: unknown): u is AnyEntry =>
  Config.isConfig(u) && Predicate.hasProperty(u, EntryTypeId);

export const name = <E extends Any>(env: E): Name<E> => env[TypeId].name;

/**
 * Every entry's key and descriptor, in declaration order.
 */
export const descriptors = (
  env: Any,
): ReadonlyArray<readonly [string, Descriptor]> =>
  env[TypeId].entries.map(
    ([key, entry]) => [key, entry[EntryTypeId].descriptor] as const,
  );

/**
 * The backend and key an entry was declared under.
 */
export const origin = (
  entry: AnyEntry,
): { readonly backend: string; readonly key: string } => ({
  backend: entry[EntryTypeId].backend,
  key: entry[EntryTypeId].key,
});
