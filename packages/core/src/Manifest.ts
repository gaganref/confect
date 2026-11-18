import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Env from "./Env.js";

/**
 * The manifest format this release writes and reads. A reader refuses any other
 * number; a change to the shape ships as the next number.
 */
export const FORMAT = 1;

/**
 * A slot a mount leaves open: its kind, and `variable`, the name the backend
 * declares it under. For an app that is the deployment's variable,
 * `<MOUNT>_<SLOT>` with acronym-aware word boundaries and uppercasing; a nested
 * child's open slot arrives already prefixed, as `<MOUNT>_<CHILD>_<SLOT>`.
 */
const descriptorFields = {
  optional: Schema.Boolean,
  automatic: Schema.optionalKey(Schema.Literal(true)),
  provider: Schema.optionalKey(
    Schema.Struct({
      selector: Schema.String,
      name: Schema.String,
      required: Schema.Boolean,
    }),
  ),
};
const slotSchema = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
) =>
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("string"),
      ...descriptorFields,
      ...fields,
    }),
    Schema.Struct({
      kind: Schema.Literal("secret"),
      ...descriptorFields,
      ...fields,
    }),
    Schema.Struct({
      kind: Schema.Literal("literals"),
      values: Schema.NonEmptyArray(Schema.String),
      ...descriptorFields,
      ...fields,
    }),
    Schema.Struct({
      kind: Schema.Literal("providers"),
      values: Schema.NonEmptyArray(Schema.String),
      ...descriptorFields,
      ...fields,
    }),
  ]);
const Descriptor = slotSchema({});
export const OpenSlot = slotSchema({ variable: Schema.String });
export type OpenSlot = typeof OpenSlot.Type;

/**
 * One mount and the slots it leaves open for the deployment.
 */
export const MountEntry = Schema.Struct({
  component: Schema.String,
  httpPrefix: Schema.optionalKey(Schema.String),
  env: Schema.Record(Schema.String, OpenSlot),
});
export type MountEntry = typeof MountEntry.Type;

/**
 * One endpoint, identified by owner, group and endpoint name.
 */
export const Route = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  owner: Schema.String,
  group: Schema.String,
  endpoint: Schema.String,
  digest: Schema.String,
});
export type Route = typeof Route.Type;

const ENV_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

type Slot = typeof Descriptor.Type & { readonly variable?: string };

/**
 * The first rule a record of slots breaks: an automatic slot is required, a
 * provider tag's selector is a `providers` slot of the same record that offers
 * the tag's provider, and each variable is a valid, unreserved name.
 */
const slotViolation = (
  at: string,
  slots: Readonly<Record<string, Slot>>,
): string | undefined => {
  for (const [key, slot] of Rec.toEntries(slots)) {
    if (
      (slot.kind === "literals" || slot.kind === "providers") &&
      new Set(slot.values).size !== slot.values.length
    )
      return `${at}.${key} has a repeated value; each values entry must be distinct`;
    if (slot.automatic === true && slot.kind === "providers")
      return `${at}.${key} is a providers slot; a providers slot cannot be automatic`;
    if (slot.automatic === true && slot.provider !== undefined)
      return `${at}.${key} is a provider setting; a provider setting cannot be automatic`;
    if (slot.automatic === true && slot.optional)
      return `${at}.${key} is automatic and optional; an automatic slot is required`;
    if (slot.kind === "providers" && slot.provider !== undefined)
      return `${at}.${key} is a providers slot; a providers slot cannot be a provider setting`;
    if (slot.provider !== undefined) {
      const { selector, name } = slot.provider;
      const chooser = Rec.has(slots, selector) ? slots[selector] : undefined;
      if (chooser?.kind !== "providers")
        return `${at}.${key} names the provider selector ${selector}, which is not a providers slot of ${at}`;
      if (!chooser.values.includes(name))
        return `${at}.${key} names the provider ${name}, which ${at}.${selector} does not offer`;
    }
    const variable = at === "env" ? key : slot.variable;
    if (variable !== undefined) {
      if (!ENV_KEY.test(variable))
        return `${at}.${key} declares the variable "${variable}", which does not use letters, digits and underscores, starting with a letter`;
      if (Result.isFailure(Env.validateKey(variable)))
        return `${at}.${key} declares the variable "${variable}", which is reserved for a Convex built-in address`;
    }
  }
  return undefined;
};

/**
 * The first rule the manifest's cross-references break: each slot record's
 * rules, and each route leaf naming the owner, group and endpoint it sits under
 * and carrying the manifest's own digest.
 */
const violation = (manifest: {
  readonly env: Readonly<Record<string, Slot>>;
  readonly mounts: Readonly<
    Record<string, { readonly env: Readonly<Record<string, Slot>> }>
  >;
  readonly http: Readonly<
    Record<string, Record<string, Record<string, Route>>>
  >;
  readonly digest: string;
}): string | undefined => {
  const env = slotViolation("env", manifest.env);
  if (env !== undefined) return env;
  for (const [mount, entry] of Rec.toEntries(manifest.mounts)) {
    const found = slotViolation(`mounts.${mount}.env`, entry.env);
    if (found !== undefined) return found;
  }
  for (const [owner, groups] of Rec.toEntries(manifest.http))
    for (const [group, endpoints] of Rec.toEntries(groups))
      for (const [endpoint, leaf] of Rec.toEntries(endpoints)) {
        const at = `http.${owner}.${group}.${endpoint}`;
        const keys = { owner, group, endpoint };
        for (const field of ["owner", "group", "endpoint"] as const)
          if (leaf[field] !== keys[field])
            return `${at} has ${field} "${leaf[field]}", not the key it sits under`;
        if (leaf.digest !== manifest.digest)
          return `${at} carries digest ${leaf.digest}, not the manifest's ${manifest.digest}`;
      }
  return undefined;
};

/**
 * The complete format 1 contract. Decode at every manifest import boundary.
 * Unknown fields are refused, including within slots, mounts and routes, and so
 * is a manifest whose provider tags, variables or route leaves do not agree
 * with the keys and digest they sit under.
 */
export const Manifest = Schema.Struct({
  format: Schema.Literal(FORMAT),
  name: Schema.String,
  env: Schema.Record(Schema.String, Descriptor),
  mounts: Schema.Record(Schema.String, MountEntry),
  http: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Record(Schema.String, Route)),
  ),
  digest: Schema.String,
  sections: Schema.Record(Schema.String, Schema.Json),
}).check(Schema.makeFilter(violation));
export type Manifest = typeof Manifest.Type;

export class UnsupportedManifestFormat extends Schema.TaggedError<
  UnsupportedManifestFormat,
  { readonly brand: unique symbol }
>()("UnsupportedManifestFormat", {
  source: Schema.String,
  reason: Schema.String,
  /**
   * `Upgrade` when the manifest names a later format than this release reads;
   * `Regenerate` for an earlier or missing format, or a malformed shape.
   */
  remedy: Schema.Literals(["Upgrade", "Regenerate"]),
}) {
  override get message(): string {
    return this.remedy === "Upgrade"
      ? `The manifest at ${this.source} is a later format than ${FORMAT}: ${this.reason}. Upgrade the Confect packages that read it to the release that generated it.`
      : `The manifest at ${this.source} does not match format ${FORMAT}: ${this.reason}. Regenerate it with confect codegen and keep the component and host generators on the same release as the reader.`;
  }
}

/**
 * Decode a manifest without throwing for a malformed format or shape.
 */
export const decode = (
  input: unknown,
  source: string,
): Result.Result<Manifest, UnsupportedManifestFormat> =>
  Schema.decodeUnknownResult(Manifest, { onExcessProperty: "error" })(
    input,
  ).pipe(
    // Validation has established this type. Keep the imported value's identity.
    Result.map(() => input as Manifest),
    Result.mapError((error) =>
      UnsupportedManifestFormat.make({
        source,
        reason: error.message,
        remedy:
          Predicate.hasProperty(input, "format") &&
          Predicate.isNumber(input.format) &&
          input.format > FORMAT
            ? "Upgrade"
            : "Regenerate",
      }),
    ),
  );

/**
 * Every route a manifest lists. A route from another build carries another
 * digest and is not one of these.
 */
export type RouteOf<M extends Manifest> = {
  [O in keyof M["http"]]: {
    [G in keyof M["http"][O]]: M["http"][O][G][keyof M["http"][O][G]];
  }[keyof M["http"][O]];
}[keyof M["http"]];

type Value<D extends Env.Descriptor> = D extends { readonly kind: "secret" }
  ? Redacted.Redacted<string>
  : D extends { readonly kind: "literals"; readonly values: infer L }
    ? L extends ReadonlyArray<infer V>
      ? V
      : never
    : D extends { readonly kind: "providers"; readonly values: infer L }
      ? L extends ReadonlyArray<infer P extends string>
        ? Env.ProviderChoice<P>
        : never
      : string;

type EnvOf = { readonly env: Readonly<Record<string, Env.Descriptor>> };

type RequiredKeys<E> = {
  [K in keyof E]: E[K] extends { readonly optional: true } ? never : K;
}[keyof E];

type SuppliedKeys<E> = {
  [K in keyof E]: E[K] extends { readonly automatic: true } ? never : K;
}[keyof E];

/**
 * The values a deployment must supply for a manifest's env, or for one mount's
 * open slots: secrets as `Redacted`, literals as one of their values, optional
 * variables omittable.
 *
 * ```ts
 * import manifest from "@tenant/convex/manifest";
 *
 * const values: Manifest.Values<typeof manifest> = {
 *   EMAIL_FROM: "noreply@example.edu",
 *   RESEND_API_KEY: Redacted.make(key),
 * };
 * ```
 */
export type Values<M extends EnvOf> = {
  readonly [
    K in Extract<RequiredKeys<M["env"]>, SuppliedKeys<M["env"]>>
  ]: Value<M["env"][K]>;
} & {
  readonly [
    K in Exclude<SuppliedKeys<M["env"]>, RequiredKeys<M["env"]>>
  ]?: Value<M["env"][K]>;
};

/**
 * The values of the automatic slots a manifest's root declares, which the
 * framework that installed them supplies.
 */
export type Automatic<M extends EnvOf> = {
  readonly [
    K in keyof M["env"] as M["env"][K] extends {
      readonly automatic: true;
    }
      ? K
      : never
  ]: Value<M["env"][K]>;
};

type RequiredMounts<M extends Manifest> = {
  [K in keyof M["mounts"]]: [RequiredKeys<M["mounts"][K]["env"]>] extends [
    never,
  ]
    ? never
    : K;
}[keyof M["mounts"]];

/**
 * The values a deployment supplies for each mount's open slots, by mount name.
 * A mount with a required open slot must appear; a name the manifest does not
 * list is refused.
 */
export type Mounts<M extends Manifest> = {
  readonly [K in RequiredMounts<M>]: Values<M["mounts"][K]>;
} & {
  readonly [K in Exclude<keyof M["mounts"], RequiredMounts<M>>]?: Values<
    M["mounts"][K]
  >;
};

/**
 * Why a supplied value does not fill a manifest slot. `mount` names the mount
 * whose open slot it is, absent for a root slot such as an automatic one. It
 * names the slot and never the value.
 */
export class SettingRefused extends Schema.TaggedError<
  SettingRefused,
  { readonly brand: unique symbol }
>()("SettingRefused", {
  mount: Schema.optionalKey(Schema.String),
  slot: Schema.optionalKey(Schema.String),
  reason: Schema.Literals([
    "UnknownMount",
    "NotOpen",
    "NotAutomatic",
    "Missing",
    "PlainSecret",
    "InvalidChoice",
    "InvalidValue",
  ]),
}) {
  override get message(): string {
    const at = pipe(
      [this.mount, this.slot],
      Arr.filter(Predicate.isString),
      Arr.join("."),
    );
    return `${at === "" ? "The manifest" : at} refuses the value supplied for it: ${this.reason}.`;
  }
}

/**
 * Whether a supplied value counts as missing: `undefined`, `null`, `""` or an
 * empty `Redacted`.
 */
export const missing = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Redacted.isRedacted(value) && Redacted.value(value) === "");

type Slots = Readonly<Record<string, Env.Descriptor>>;

/**
 * A provider choice validated and encoded with the schema the handler decodes
 * it with, after refusing a choice that names a provider whose required setting
 * in `supplied` is missing. A setting belongs to the selector its tag names. An
 * optional selector left missing is not written.
 */
export const settleChoice = (
  key: string,
  selector: Env.Descriptor & { readonly kind: "providers" },
  slots: Slots,
  supplied: Readonly<Record<string, unknown>>,
  value: unknown,
): Result.Result<string | undefined, SettingRefused> => {
  if (selector.optional && missing(value)) return Result.succeed(undefined);
  const invalid = SettingRefused.make({ slot: key, reason: "InvalidChoice" });
  const schema = Env.providerChoice(selector.values);
  return Result.gen(function* () {
    const choice = yield* Schema.decodeUnknownResult(Schema.toType(schema))(
      value,
    ).pipe(Result.mapError(() => invalid));
    const named = Env.chosen(choice);
    for (const [slot, other] of Rec.toEntries(slots)) {
      if (
        other.provider?.selector === key &&
        other.provider.required &&
        named.includes(other.provider.name) &&
        missing(Rec.has(supplied, slot) ? supplied[slot] : undefined)
      )
        return yield* Result.fail(
          SettingRefused.make({ slot, reason: "Missing" }),
        );
    }
    return yield* Schema.encodeUnknownResult(schema)(choice).pipe(
      Result.mapError(() => invalid),
    );
  });
};

/**
 * One slot's supplied value, checked against its descriptor: a missing required
 * slot, a plain string for a secret and any other value of the wrong kind are
 * refused, and a missing optional slot is not written. A missing setting of a
 * provider that `choice` names, and requires, is refused too. A selector's own
 * value is checked by {@link settleChoice}.
 */
export const settleSlot = (
  slots: Slots,
  key: string,
  value: unknown,
  choice: unknown,
): Result.Result<unknown, SettingRefused> => {
  const descriptor = slots[key]!;
  if (missing(value)) {
    const provider = descriptor.provider;
    const selector =
      provider === undefined ? undefined : slots[provider.selector];
    if (
      provider?.required === true &&
      selector?.kind === "providers" &&
      !missing(choice)
    ) {
      const checked = settleChoice(
        provider.selector,
        selector,
        { [key]: descriptor },
        { [key]: value },
        choice,
      );
      if (Result.isFailure(checked)) return checked;
    }
    return descriptor.optional
      ? Result.succeed(undefined)
      : Result.fail(SettingRefused.make({ slot: key, reason: "Missing" }));
  }
  if (descriptor.kind === "secret" && Predicate.isString(value))
    return Result.fail(
      SettingRefused.make({ slot: key, reason: "PlainSecret" }),
    );
  const valid =
    descriptor.kind === "secret"
      ? Redacted.isRedacted(value) &&
        pipe(value, Redacted.value, Predicate.isString)
      : descriptor.kind === "providers" ||
        (Predicate.isString(value) &&
          (descriptor.kind !== "literals" ||
            descriptor.values.includes(value)));
  return valid
    ? Result.succeed(value)
    : Result.fail(SettingRefused.make({ slot: key, reason: "InvalidValue" }));
};

/**
 * A record of slots' supplied values, each checked by {@link settleSlot} and
 * each selector's by {@link settleChoice}, holding only the values written.
 * Secrets stay `Redacted` and a provider choice is encoded.
 */
export const settle = (
  slots: Slots,
  supplied: Readonly<Record<string, unknown>>,
): Result.Result<Record<string, unknown>, SettingRefused> =>
  Result.gen(function* () {
    const at = (record: Readonly<Record<string, unknown>>, key: string) =>
      Rec.has(record, key) ? record[key] : undefined;
    const settings: Record<string, unknown> = {};
    for (const [key, descriptor] of Rec.toEntries(slots)) {
      const choice =
        descriptor.provider === undefined
          ? undefined
          : at(supplied, descriptor.provider.selector);
      const checked = yield* settleSlot(slots, key, at(supplied, key), choice);
      if (checked !== undefined) settings[key] = checked;
    }
    for (const [key, descriptor] of Rec.toEntries(slots)) {
      if (descriptor.kind !== "providers" || !Rec.has(settings, key)) continue;
      const tagged = Rec.filter(
        settings,
        (_, slot) => slots[slot]?.provider?.selector === key,
      );
      settings[key] = yield* settleChoice(
        key,
        descriptor,
        slots,
        tagged,
        settings[key],
      );
    }
    return settings;
  });

/**
 * Refuse a supplied mount the manifest does not list.
 */
export const checkMounts = (
  manifest: Manifest,
  mounts: Readonly<Record<string, unknown>>,
): Result.Result<void, SettingRefused> => {
  for (const mount of Rec.keys(mounts)) {
    if (!Rec.has(manifest.mounts, mount))
      return Result.fail(
        SettingRefused.make({ mount, reason: "UnknownMount" }),
      );
  }
  return Result.succeed(undefined);
};

/**
 * Refuse a slot supplied for `mount` that the manifest does not list as open.
 */
export const checkOpen = (
  manifest: Manifest,
  mount: string,
  supplied: Readonly<Record<string, unknown>>,
): Result.Result<void, SettingRefused> => {
  const open = Rec.has(manifest.mounts, mount)
    ? manifest.mounts[mount]!.env
    : {};
  for (const slot of Rec.keys(supplied)) {
    if (!Rec.has(open, slot))
      return Result.fail(
        SettingRefused.make({ mount, slot, reason: "NotOpen" }),
      );
  }
  return Result.succeed(undefined);
};

/**
 * Refuse a supplied automatic value for a slot the manifest's root does not
 * declare automatic, and a missing value for one it does.
 */
export const checkAutomatic = (
  manifest: Manifest,
  supplied: Readonly<Record<string, unknown>>,
): Result.Result<void, SettingRefused> => {
  for (const slot of Rec.keys(supplied)) {
    if (!Rec.has(manifest.env, slot) || manifest.env[slot]?.automatic !== true)
      return Result.fail(SettingRefused.make({ slot, reason: "NotAutomatic" }));
  }
  for (const [slot, descriptor] of Rec.toEntries(manifest.env)) {
    if (
      descriptor.automatic === true &&
      missing(Rec.has(supplied, slot) ? supplied[slot] : undefined)
    )
      return Result.fail(SettingRefused.make({ slot, reason: "Missing" }));
  }
  return Result.succeed(undefined);
};

/**
 * Each mount's open slots and each automatic slot, as a deployment writes them,
 * under the variable the manifest names: a mount's slot under its `variable`,
 * an automatic slot under its own name. Every mount is checked by
 * {@link checkMounts}, then each in manifest order by {@link checkOpen} and
 * {@link settle}, then the automatic slots by {@link checkAutomatic} and
 * {@link settle}. A refusal of a mount's slot names the mount.
 */
export const variables = (
  manifest: Manifest,
  supplied: {
    readonly mounts: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    readonly automatic: Readonly<Record<string, unknown>>;
  },
): Result.Result<Record<string, unknown>, SettingRefused> =>
  Result.gen(function* () {
    yield* checkMounts(manifest, supplied.mounts);
    const written: Record<string, unknown> = {};
    for (const [mount, entry] of Rec.toEntries(manifest.mounts)) {
      const values =
        (Rec.has(supplied.mounts, mount)
          ? supplied.mounts[mount]
          : undefined) ?? {};
      yield* checkOpen(manifest, mount, values);
      const settings = yield* settle(entry.env, values).pipe(
        Result.mapError(({ slot, reason }) =>
          SettingRefused.make({
            mount,
            reason,
            ...(slot === undefined ? {} : { slot }),
          }),
        ),
      );
      for (const [slot, value] of Rec.toEntries(settings))
        written[entry.env[slot]!.variable] = value;
    }
    yield* checkAutomatic(manifest, supplied.automatic);
    const automatic = yield* settle(
      Rec.filter(manifest.env, (slot) => slot.automatic === true),
      supplied.automatic,
    );
    return { ...automatic, ...written };
  });
