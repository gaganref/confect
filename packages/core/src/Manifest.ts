import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
import type * as Env from "./Env.js";

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
    Schema.Struct({ name: Schema.String, required: Schema.Boolean }),
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

/**
 * The complete format 1 contract. Decode at every manifest import boundary.
 * Unknown fields are refused, including within slots, mounts and routes.
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
});
export type Manifest = typeof Manifest.Type;

export class UnsupportedManifestFormat extends Schema.TaggedError<
  UnsupportedManifestFormat,
  { readonly brand: unique symbol }
>()("UnsupportedManifestFormat", {
  source: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `The manifest at ${this.source} does not match format ${FORMAT}: ${this.reason}. Regenerate it with confect codegen and keep the component and host generators on the same release as the reader.`;
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
      UnsupportedManifestFormat.make({ source, reason: error.message }),
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
