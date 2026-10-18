import type { AuthProvider } from "convex/server";
import * as Predicate from "effect/Predicate";
import type * as App from "./App";
import type { TypeError } from "./Types";

const TypeId = "~@confect/core/Auth";
const SiteUrlTypeId = "~@confect/core/Auth/SiteUrl";

/**
 * The deployment's site URL (`CONVEX_SITE_URL`) plus a path, resolved when
 * Convex loads `auth.config.ts`.
 */
export interface SiteUrl {
  readonly [SiteUrlTypeId]: typeof SiteUrlTypeId;
  readonly path: string;
}

type Url = string | SiteUrl;

type WithSiteUrl<P> = P extends unknown
  ? {
      [K in keyof P]: K extends "domain" | "issuer" | "jwks" ? Url : P[K];
    }
  : never;

/**
 * Convex's `AuthProvider`, with `domain`, `issuer` and `jwks` also taking a
 * {@link SiteUrl}.
 */
export type Provider = WithSiteUrl<AuthProvider>;

export interface Auth<A extends App.Any> {
  readonly [TypeId]: typeof TypeId;
  readonly app: A;
  readonly providers: ReadonlyArray<Provider>;
}

export type Any = Auth<App.Any>;

/**
 * The site URL, or a path under it. Pass a mount to point at that mounted
 * component's HTTP routes.
 */
export function siteUrl(path?: `/${string}`): SiteUrl;
export function siteUrl(
  mount: { readonly httpPrefix: App.HttpPrefix },
  path?: `/${string}`,
): SiteUrl;
export function siteUrl(
  pathOrMount?: `/${string}` | { readonly httpPrefix: App.HttpPrefix },
  path: string = "",
): SiteUrl {
  return {
    [SiteUrlTypeId]: SiteUrlTypeId,
    path:
      typeof pathOrMount === "object"
        ? pathOrMount.httpPrefix.replace(/\/+$/, "") + path
        : (pathOrMount ?? ""),
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
  options: { readonly providers: ReadonlyArray<Provider> },
): Auth<A> => ({ [TypeId]: TypeId, app, providers: options.providers });

export const isAuth = (u: unknown): u is Any =>
  Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId;

export const providers = (auth: Any): ReadonlyArray<Provider> => auth.providers;

/**
 * The path of a {@link SiteUrl}, or `undefined` for any other value.
 */
export const siteUrlPath = (u: unknown): string | undefined =>
  Predicate.hasProperty(u, SiteUrlTypeId) &&
  Predicate.hasProperty(u, "path") &&
  typeof u.path === "string"
    ? u.path
    : undefined;
