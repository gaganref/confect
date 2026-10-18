import type * as Redacted from "effect/Redacted";
import type * as Env from "./Env";

/**
 * The shape of `confect/_generated/manifest.ts`: plain data with no imports,
 * which infra reads instead of backend code. `env` lists each variable with its
 * kind, `http.mounts` each mount's HTTP prefix, and `digest` identifies the
 * declaration inputs it was generated from.
 */
export interface Manifest {
  readonly name: string;
  readonly env: Readonly<Record<string, Env.Descriptor>>;
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

/**
 * The values a deployment must supply for a manifest's env: secrets as
 * `Redacted`, literals as one of their values, optional variables omittable.
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
export type Values<M extends Manifest> = {
  readonly [
    K in keyof M["env"] as M["env"][K]["optional"] extends true ? never : K
  ]: Value<M["env"][K]>;
} & {
  readonly [
    K in keyof M["env"] as M["env"][K]["optional"] extends true ? K : never
  ]?: Value<M["env"][K]>;
};
