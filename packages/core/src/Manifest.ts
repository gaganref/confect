import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
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
 * the tag's provider, and an open slot's variable is a valid, unreserved name.
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
    if (slot.provider !== undefined) {
      const { selector, name } = slot.provider;
      const chooser = Rec.has(slots, selector) ? slots[selector] : undefined;
      if (chooser?.kind !== "providers")
        return `${at}.${key} names the provider selector ${selector}, which is not a providers slot of ${at}`;
      if (!chooser.values.includes(name))
        return `${at}.${key} names the provider ${name}, which ${at}.${selector} does not offer`;
    }
    if (slot.variable !== undefined) {
      if (!ENV_KEY.test(slot.variable))
        return `${at}.${key} declares the variable "${slot.variable}", which does not use letters, digits and underscores, starting with a letter`;
      if (Result.isFailure(Env.validateKey(slot.variable)))
        return `${at}.${key} declares the variable "${slot.variable}", which is reserved for a Convex built-in address`;
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
