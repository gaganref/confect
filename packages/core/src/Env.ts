import * as Config from "effect/Config";
import type * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Redacted from "effect/Redacted";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const TypeId = "~@confect/core/Env";
const EntryTypeId = "~@confect/core/Env/Entry";

const reservedKeys = ["CONVEX_SITE_URL", "CONVEX_CLOUD_URL"] as const;

type GroupKeys<A> = [A] extends [
  Configured<infer G> | Option.Option<Configured<infer G>>,
]
  ? { [P in keyof G]: keyof G[P] }[keyof G]
  : never;

type SettingKeys<Fields> = {
  [K in keyof Fields]: Fields[K] extends Field<infer A, string, boolean>
    ? GroupKeys<A>
    : never;
}[keyof Fields];

export type CheckKeys<Fields> = {
  readonly [K in keyof Fields]: K extends (typeof reservedKeys)[number]
    ? { readonly reservedForConvexBuiltIn: never }
    : string extends SettingKeys<Fields>
      ? Fields[K]
      : K extends SettingKeys<Fields>
        ? { readonly declaredAsProviderSetting: never }
        : Fields[K];
};

export class ReservedEnvKey extends Schema.TaggedError<
  ReservedEnvKey,
  { readonly brand: unique symbol }
>()("ReservedEnvKey", { key: Schema.String }) {
  override get message(): string {
    return `The env slot "${this.key}" is reserved for a Convex built-in address; read it without declaring a slot.`;
  }
}

export class DuplicateEnvKey extends Schema.TaggedError<
  DuplicateEnvKey,
  { readonly brand: unique symbol }
>()("DuplicateEnvKey", {
  key: Schema.String,
  first: Schema.String,
  second: Schema.String,
}) {
  override get message(): string {
    return `The env slot "${this.key}" is declared by ${this.first} and by ${this.second}; give each its own name.`;
  }
}

export class InvalidAutomaticField extends Schema.TaggedError<
  InvalidAutomaticField,
  { readonly brand: unique symbol }
>()("InvalidAutomaticField", {
  reason: Schema.Literals([
    "ProviderSelector",
    "ProviderSetting",
    "NestedSelector",
  ]),
  provider: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
}) {
  override get message(): string {
    if (this.reason === "NestedSelector")
      return `Provider ${this.provider} setting ${this.key} cannot be a providers selector; declare each selector as a top-level slot.`;
    return this.reason === "ProviderSelector"
      ? "A providers selector cannot be automatic; supply its choice from the deployment."
      : "A provider setting cannot be automatic; declare a value shared by providers as an ordinary slot.";
  }
}

/**
 * Refuse keys that would override Convex's built-in deployment addresses.
 */
export const validateKey = (key: string): Result.Result<void, ReservedEnvKey> =>
  Arr.some(reservedKeys, (reserved) => reserved === key)
    ? Result.fail(ReservedEnvKey.make({ key }))
    : Result.succeed(undefined);

/**
 * What one environment variable is, as plain data. Codegen renders it as a
 * Convex validator in `convex.config.ts` and copies it into the generated
 * manifest unchanged.
 */
export type Descriptor = (
  | { readonly kind: "string"; readonly optional: boolean }
  | { readonly kind: "secret"; readonly optional: boolean }
  | {
      readonly kind: "literals";
      readonly values: readonly [string, ...Array<string>];
      readonly optional: boolean;
    }
  | {
      /**
       * A provider choice from {@link providers}: `values` names the providers,
       * and the stack writes one, `{ active, standby }` or `{ pool }`.
       */
      readonly kind: "providers";
      readonly values: readonly [string, ...Array<string>];
      readonly optional: boolean;
    }
) & {
  /**
   * A slot one provider of a {@link providers} choice reads: unset unless the
   * choice in the `providers` slot `selector`, of the same record, names that
   * provider, and then required when `required` says so.
   */
  readonly provider?: {
    readonly selector: string;
    readonly name: string;
    readonly required: boolean;
  };
  /**
   * Set by {@link automatic}: every parent binds this slot to its own slot of
   * the same name, so it is never open and reaches the root once.
   */
  readonly automatic?: true;
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
  /**
   * Provider groups expanded into optional slots by make.
   */
  readonly groups?: Readonly<
    Record<string, Readonly<Record<string, AnyField>>>
  >;
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

export class DuplicateEnvValue extends Schema.TaggedError<
  DuplicateEnvValue,
  { readonly brand: unique symbol }
>()("DuplicateEnvValue", { value: Schema.String }) {
  override get message(): string {
    return `The env choice repeats "${this.value}"; give each value once.`;
  }
}

type HasDuplicate<L extends ReadonlyArray<string>> = string extends L[number]
  ? false
  : L extends readonly [
        infer Head extends string,
        ...infer Tail extends ReadonlyArray<string>,
      ]
    ? Head extends Tail[number]
      ? true
      : HasDuplicate<Tail>
    : false;

/**
 * A variable that must be one of the distinct given strings.
 */
export const literals = <const L extends readonly [string, ...Array<string>]>(
  values: L & (HasDuplicate<L> extends true ? never : unknown),
): Field<L[number], L[number], false> => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw DuplicateEnvValue.make({ value });
    seen.add(value);
  }
  return {
    descriptor: { kind: "literals", values, optional: false },
    config: (key) => Config.Literals(values, key),
  };
};

/**
 * A variable that may be unset; a handler reads it as an `Option`.
 */
export const optional = <A, Value extends string>(
  field: Field<A, Value, false>,
): Field<Option.Option<A>, Value, true> => {
  const { "~optional": _, ...required } = field;
  return {
    ...required,
    descriptor: { ...field.descriptor, optional: true },
    config: (key) => Config.option(field.config(key)),
  };
};

/**
 * A required variable a framework fills in every backend: codegen binds it in
 * each parent to the parent's slot of the same name, declaring that slot when
 * the parent does not, so no mount leaves it open and the root declares it
 * once. The stack supplies it apart from the slots a product fills.
 */
export const automatic = <A, Value extends string>(
  field: Field<A, Value, false> &
    (A extends Configured<Record<string, Record<string, AnyField>>>
      ? never
      : unknown),
): Field<A, Value, false> => {
  if (field.descriptor.kind === "providers")
    throw InvalidAutomaticField.make({ reason: "ProviderSelector" });
  if (field.descriptor.provider !== undefined)
    throw InvalidAutomaticField.make({ reason: "ProviderSetting" });
  return {
    ...field,
    descriptor: { ...field.descriptor, automatic: true },
    config: field.config,
  };
};

/**
 * What a provider choice names: one provider; an active one with standbys,
 * every one of them supplied; or a pool the component distributes over.
 */
export type ProviderChoice<P extends string = string> =
  | P
  | { readonly active: P; readonly standby: readonly [P, ...Array<P>] }
  | { readonly pool: readonly [P, ...Array<P>] };

type GroupValues<G extends Record<string, Record<string, AnyField>>> = {
  readonly [P in keyof G]: {
    readonly [K in keyof G[P]]: G[P][K] extends Field<infer A, string, boolean>
      ? A
      : never;
  };
};

/**
 * What a handler reads from a provider choice: the choice, and the settings of
 * each provider it names.
 */
export interface Configured<
  G extends Record<string, Record<string, AnyField>>,
> {
  readonly choice: ProviderChoice<keyof G & string>;
  readonly providers: Partial<GroupValues<G>>;
}

/**
 * The providers a choice names.
 */
export const chosen = <P extends string>(
  choice: ProviderChoice<P>,
): readonly [P, ...Array<P>] =>
  Predicate.isString(choice)
    ? [choice]
    : "pool" in choice
      ? choice.pool
      : [choice.active, ...choice.standby];

/**
 * The schema a handler decodes a provider choice with, from the string Convex
 * stores: a provider's name, or a JSON failover or pool of the named providers.
 * A stack encodes a choice with it before writing the variable.
 */
export const providerChoice = (names: readonly [string, ...Array<string>]) => {
  const name = Schema.Literals(names);
  const list = Schema.NonEmptyArray(name);
  return Schema.Union([
    name,
    Schema.fromJsonString(
      Schema.Union([
        Schema.Struct({ active: name, standby: list }).check(
          Schema.makeFilter(({ active, standby }) =>
            standby.includes(active)
              ? `${active} is both active and a standby`
              : undefined,
          ),
        ),
        Schema.Struct({ pool: list }),
      ]),
    ),
  ]);
};

/**
 * A provider choice and each provider's own slots. The stack writes the choice
 * as plain data and supplies the slots of every provider it names; a handler
 * reads the choice with the named providers' settings. Each provider's slots
 * are declared beside the choice, under their own names.
 *
 * ```ts
 * EMAIL_PROVIDER: Env.providers({
 *   ses: { SES_REGION: Env.string(), SES_SECRET_ACCESS_KEY: Env.secret() },
 *   resend: { RESEND_API_KEY: Env.secret() },
 * }),
 * ```
 */
type ProviderSettings<G extends Record<string, Record<string, AnyField>>> = {
  readonly [P in keyof G]: {
    readonly [K in keyof G[P]]: G[P][K] extends Field<infer A, string, boolean>
      ? unknown extends A
        ? G[P][K]
        : [A] extends [
              | Configured<Record<string, Record<string, AnyField>>>
              | Option.Option<
                  Configured<Record<string, Record<string, AnyField>>>
                >,
            ]
          ? never
          : G[P][K]
      : never;
  };
};

export const providers = <
  const G extends Record<string, Record<string, AnyField>>,
>(
  groups: G & ProviderSettings<G>,
): Field<Configured<G>, string, false> => {
  for (const [provider, slots] of Rec.toEntries(groups)) {
    for (const [key, field] of Rec.toEntries(slots)) {
      if (field.descriptor.kind === "providers")
        throw InvalidAutomaticField.make({
          reason: "NestedSelector",
          provider,
          key,
        });
      if (field.descriptor.automatic === true)
        throw InvalidAutomaticField.make({ reason: "ProviderSetting" });
    }
  }
  const names = Rec.keys(groups) as unknown as readonly [
    string,
    ...Array<string>,
  ];
  const schema = providerChoice(names);
  return {
    descriptor: { kind: "providers", values: names, optional: false },
    groups,
    config: (key) =>
      Config.schema(schema, key).pipe(
        Config.flatMap((choice) =>
          Config.map(
            Config.all(
              Rec.fromEntries(
                Arr.map(chosen(choice as ProviderChoice), (provider) => [
                  provider,
                  Config.all(
                    Rec.map(groups[provider]!, (field, slot) =>
                      field.config(slot),
                    ),
                  ),
                ]),
              ),
            ),
            (settings) =>
              ({ choice, providers: settings }) as unknown as Configured<G>,
          ),
        ),
      ),
  };
};

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
  fields: Fields & CheckKeys<Fields>,
): Env<N, Fields> => {
  for (const key of Rec.keys(fields)) Result.getOrThrow(validateKey(key));
  const entry = (key: string, field: AnyField, descriptor: Descriptor) => {
    Result.getOrThrow(validateKey(key));
    return [
      key,
      Object.assign(field.config(key), {
        [EntryTypeId]: {
          backend: name,
          key,
          descriptor,
          optional: descriptor.optional,
        },
      }),
    ] as const;
  };
  // A provider choice declares each provider's slots beside it, unset unless
  // the choice names that provider.
  const declared = Arr.flatMap(Rec.toEntries(fields), ([key, field]) => [
    { key, at: key, field, descriptor: field.descriptor },
    ...Arr.flatMap(Rec.toEntries(field.groups ?? {}), ([provider, slots]) =>
      Arr.map(Rec.toEntries(slots), ([slot, inner]) => ({
        key: slot,
        at: `${key}.${provider}.${slot}`,
        field: inner,
        descriptor: {
          ...inner.descriptor,
          optional: true,
          provider: {
            selector: key,
            name: provider,
            required: !inner.descriptor.optional,
          },
        },
      })),
    ),
  ]);
  const seen = new Map<string, string>();
  for (const { key, at } of declared) {
    const first = seen.get(key);
    if (first !== undefined)
      throw DuplicateEnvKey.make({ key, first, second: at });
    seen.set(key, at);
  }
  const entries = Arr.map(declared, ({ key, field, descriptor }) =>
    entry(key, field, descriptor),
  );
  // The entries are built from `fields` key by key, which TypeScript cannot
  // correlate through `Object.fromEntries`.
  return {
    ...Rec.fromEntries(entries),
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
  Arr.map(
    env[TypeId].entries,
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
