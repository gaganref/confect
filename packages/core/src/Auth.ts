import type { AuthProvider } from "convex/server";
import * as Predicate from "effect/Predicate";
import type * as App from "./App.js";
import type * as Env from "./Env.js";
import * as Mount from "./Mount.js";
import type { TypeError } from "./Types.js";
import * as String from "effect/String";
import { pipe } from "effect/Function";

const TypeId = "~@confect/core/Auth";
const CloudUrlTypeId = "~@confect/core/Auth/CloudUrl";
const SiteUrlTypeId = "~@confect/core/Auth/SiteUrl";
const FamilyTypeId = "~@confect/core/Auth/Family";

/**
 * The deployment's site URL (`CONVEX_SITE_URL`) plus a path, resolved when
 * Convex loads `auth.config.ts`.
 */
export interface SiteUrl {
  readonly [SiteUrlTypeId]: typeof SiteUrlTypeId;
  readonly path: string;
}

/**
 * The deployment's cloud URL (`CONVEX_CLOUD_URL`) plus a path.
 */
export interface CloudUrl {
  readonly [CloudUrlTypeId]: typeof CloudUrlTypeId;
  readonly path: string;
}

type Url =
  | string
  | SiteUrl
  | CloudUrl
  | Env.Entry<string, string, string, false>;

type WithUrls<P> = P extends unknown
  ? {
      [K in keyof P]: K extends "domain" | "issuer" | "jwks" | "applicationID"
        ? Url
        : P[K];
    }
  : never;

/**
 * Convex's provider list with deployment URLs and required, public env strings.
 */
export type Provider = WithUrls<AuthProvider> & {
  /**
   * Application-defined token family, copied to the runtime provider data.
   */
  readonly family?: string;
  /**
   * Application-defined issuer name, for example a trusted service.
   */
  readonly name?: string;
};

/**
 * A family of `customJwt` providers whose issuers come from one env value,
 * expanded when Convex loads `auth.config.ts`. See `AuthFamily` for the value's
 * format.
 */
export interface Family {
  readonly [FamilyTypeId]: typeof FamilyTypeId;
  readonly family: string;
  readonly issuers: Env.Entry<string, string, string, false>;
  readonly algorithm: "RS256" | "ES256";
}

/**
 * Declare a provider family in `Auth.make`'s providers. Adding or removing an
 * issuer is a change to the env value, with no codegen run or redeploy.
 *
 * ```ts
 * Auth.family({
 *   family: "service",
 *   issuers: env.PEER_SERVICES,
 *   algorithm: "ES256",
 * });
 * ```
 */
export const family = (options: Omit<Family, typeof FamilyTypeId>): Family => ({
  [FamilyTypeId]: FamilyTypeId,
  ...options,
});

export const isFamily = (u: unknown): u is Family =>
  Predicate.hasProperty(u, FamilyTypeId);

/**
 * The cloud URL, or a path under it, resolved when Convex loads auth config.
 */
export const cloudUrl = (path: `/${string}` | "" = ""): CloudUrl => ({
  [CloudUrlTypeId]: CloudUrlTypeId,
  path,
});

/**
 * The path of a cloud URL placeholder, or `undefined` for another value.
 */
export const cloudUrlPath = (u: unknown): string | undefined =>
  Predicate.hasProperty(u, CloudUrlTypeId) &&
  Predicate.hasProperty(u, "path") &&
  typeof u.path === "string"
    ? u.path
    : undefined;

export interface Auth<A extends App.Any> {
  readonly [TypeId]: typeof TypeId;
  readonly app: A;
  readonly providers: ReadonlyArray<Provider | Family>;
}

export type Any = Auth<App.Any>;

/**
 * The site URL, or a path under it. Pass a mount to point at that mounted
 * component's HTTP routes.
 */
export function siteUrl(path?: `/${string}`): SiteUrl;
export function siteUrl(
  mount: Mount.Mount<any, string, Mount.Declared<App.HttpPrefix>>,
  path?: `/${string}`,
): SiteUrl;
export function siteUrl(
  pathOrMount?: `/${string}` | Mount.Any,
  path: string = "",
): SiteUrl {
  return {
    [SiteUrlTypeId]: SiteUrlTypeId,
    path:
      typeof pathOrMount === "string" || pathOrMount === undefined
        ? (pathOrMount ?? "")
        : pipe(
            Mount.data(pathOrMount).httpPrefix ?? "",
            String.replace(/\/+$/, ""),
          ) + path,
  };
}

export type AppOnlyError = TypeError<
  "Auth.make accepts only app declarations; components receive identity through function arguments",
  never
>;

type AppOnly<A extends App.Any> = [A["kind"]] extends ["app"]
  ? unknown
  : AppOnlyError;

/**
 * Declare the identity providers whose tokens the backend accepts, in
 * `confect/auth.ts`. This is Convex's own provider list; codegen writes it to
 * `convex/auth.config.ts`.
 *
 * ```ts
 * export default Auth.make(app, {
 *   providers: [
 *     { domain: "https://login.example.edu", applicationID: "tenant" },
 *   ],
 * });
 * ```
 */
export const make = <A extends App.Any>(
  app: A & AppOnly<NoInfer<A>>,
  options: { readonly providers: ReadonlyArray<Provider | Family> },
): Auth<A> => ({ [TypeId]: TypeId, app, providers: options.providers });

export const isAuth = (u: unknown): u is Any =>
  Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId;

export const providers = (auth: Any): ReadonlyArray<Provider | Family> =>
  auth.providers;

/**
 * The path of a {@link SiteUrl}, or `undefined` for any other value.
 */
export const siteUrlPath = (u: unknown): string | undefined =>
  Predicate.hasProperty(u, SiteUrlTypeId) &&
  Predicate.hasProperty(u, "path") &&
  typeof u.path === "string"
    ? u.path
    : undefined;
