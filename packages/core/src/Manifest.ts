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
 * `<MOUNT>_<SLOT>` with camelCase mount names split at each capital and
 * uppercased; a nested child's open slot arrives already prefixed, as
 * `<MOUNT>_<CHILD>_<SLOT>`.
 */
export type OpenSlot = Env.Descriptor & { readonly variable: string };

/**
 * One mount the backend declares: its component's Convex name, its HTTP prefix
 * if any, and only the slots left open for the stack.
 */
export interface MountEntry {
  readonly component: string;
  readonly httpPrefix?: string;
  readonly env: Readonly<Record<string, OpenSlot>>;
}

/**
 * The shape of `confect/_generated/manifest.ts`: plain data with no imports,
 * which infra reads instead of backend code, and which a component ships so a
 * host's codegen can read it. `env` lists each variable with its kind, `mounts`
 * every mount with its open slots, `http.mounts` each mount's HTTP prefix, and
 * `digest` identifies the declaration inputs it was generated from.
 */
export interface Manifest {
  readonly format: typeof FORMAT;
  readonly name: string;
  readonly env: Readonly<Record<string, Env.Descriptor>>;
  readonly mounts: Readonly<Record<string, MountEntry>>;
  readonly http: { readonly mounts: Readonly<Record<string, string>> };
  readonly digest: string;
}

type Value<D extends Env.Descriptor> = D extends { readonly kind: "secret" }
  ? Redacted.Redacted<string>
  : D extends { readonly kind: "literals"; readonly values: infer L }
    ? L extends ReadonlyArray<infer V>
      ? V
      : never
    : string;

type EnvOf = { readonly env: Readonly<Record<string, Env.Descriptor>> };

type RequiredKeys<E> = {
  [K in keyof E]: E[K] extends { readonly optional: true } ? never : K;
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
  readonly [K in RequiredKeys<M["env"]>]: Value<M["env"][K]>;
} & {
  readonly [K in Exclude<keyof M["env"], RequiredKeys<M["env"]>>]?: Value<
    M["env"][K]
  >;
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
