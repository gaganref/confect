/**
 * A provider family: a set of peer issuers read from one env value, expanded
 * into one Convex provider per issuer when Convex loads `auth.config.ts`, and
 * read the same way by `confect/_generated/auth.providers.ts` at request time.
 *
 * The value is a JSON array. Each issuer has a `name`, an `issuer` URL, a
 * `jwks` URL or data URI, and an optional `applicationID` (its audience):
 *
 * ```json
 * [
 *   {
 *     "name": "platform",
 *     "issuer": "https://platform.convex.cloud/components/auth",
 *     "jwks": "https://platform.convex.cloud/.well-known/jwks.json",
 *     "applicationID": "https://tenant.convex.site"
 *   }
 * ]
 * ```
 *
 * Convex bundles this module into `auth.config.js` and evaluates it with no
 * clock and no randomness, so nothing here may read either as it loads.
 */
import type { AuthProvider } from "convex/server";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * An issuer as Convex compares it: with `https://` when it has no scheme, and
 * without trailing slashes.
 */
const issuerKey = (issuer: string): string =>
  pipe(
    /^https?:\/\//.test(issuer) ? issuer : `https://${issuer}`,
    Str.replace(/\/+$/, ""),
  );

const listFault = (
  issuers: ReadonlyArray<{ readonly name: string; readonly issuer: string }>,
): string | undefined => {
  if (issuers.length === 0) return "it lists no issuers";
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const { name, issuer } of issuers) {
    if (names.has(name)) return `it names "${name}" twice`;
    if (keys.has(issuerKey(issuer))) return `it lists issuer "${issuer}" twice`;
    names.add(name);
    keys.add(issuerKey(issuer));
  }
  return undefined;
};

const Issuer = Schema.Struct({
  name: Schema.NonEmptyString,
  issuer: Schema.NonEmptyString,
  jwks: Schema.NonEmptyString,
  applicationID: Schema.optionalKey(Schema.NonEmptyString),
});

export type Issuer = typeof Issuer.Type;

const Issuers = Schema.fromJsonString(
  Schema.Array(Issuer).check(Schema.makeFilter(listFault)),
);

export class InvalidIssuers extends Schema.TaggedError<
  InvalidIssuers,
  { readonly brand: unique symbol }
>()("InvalidIssuers", { key: Schema.String, reason: Schema.String }) {
  override get message(): string {
    return `${this.key} is not a valid issuer list: ${this.reason}. List the issuers as a JSON array of { "name", "issuer", "jwks", "applicationID"? }.`;
  }
}

/**
 * Parse a family's env value. Any fault refuses the whole list: an unset, empty
 * or malformed value, an empty list, an unknown field, or a name or issuer
 * listed twice.
 */
export const parse = (
  key: string,
  value: string | undefined,
): Result.Result<ReadonlyArray<Issuer>, InvalidIssuers> =>
  value === undefined || Str.trim(value) === ""
    ? Result.fail(
        InvalidIssuers.make({
          key,
          reason: value === undefined ? "it is not set" : "it is empty",
        }),
      )
    : pipe(
        Schema.decodeResult(Issuers, { onExcessProperty: "error" })(value),
        Result.mapError((error) =>
          InvalidIssuers.make({ key, reason: error.message }),
        ),
      );

/**
 * A family as the generated files pass it: its name, its env key, and that
 * key's value in the deployment.
 */
export interface Source {
  readonly family: string;
  readonly key: string;
  readonly value: string | undefined;
}

/**
 * An issuer the backend accepts, as `confect/_generated/auth.providers.ts`
 * lists it.
 */
export interface Provider {
  readonly issuer: string;
  readonly audience?: string;
  readonly family?: string;
  readonly name?: string;
}

const providerIssuer = (provider: AuthProvider): string =>
  "issuer" in provider ? provider.issuer : provider.domain;

/**
 * `convex/auth.config.ts`'s provider list: the static providers, then one
 * `customJwt` provider per family issuer. It throws, failing the push or the
 * env change, when a family's value is invalid or a family issuer is also
 * another provider's.
 */
export const config = (
  statics: ReadonlyArray<AuthProvider>,
  families: ReadonlyArray<Source & { readonly algorithm: "RS256" | "ES256" }>,
): Array<AuthProvider> => {
  const members = Arr.flatMap(families, (family) => {
    const parsed = parse(family.key, family.value);
    if (Result.isFailure(parsed)) {
      throw new Error(
        `Provider family "${family.family}" reads its issuers from ${family.key}, and ${parsed.failure.message}`,
      );
    }
    return Arr.map(parsed.success, ({ name, issuer, jwks, applicationID }) => {
      const provider: AuthProvider & { readonly issuer: string } =
        applicationID === undefined
          ? { type: "customJwt", issuer, jwks, algorithm: family.algorithm }
          : {
              type: "customJwt",
              issuer,
              jwks,
              applicationID,
              algorithm: family.algorithm,
            };
      return {
        owner: `provider family "${family.family}" (${name})`,
        provider,
      };
    });
  });
  const all = [...statics, ...Arr.map(members, ({ provider }) => provider)];
  for (const { owner, provider: member } of members) {
    const key = issuerKey(member.issuer);
    const sharing = Arr.filter(
      all,
      (provider) => issuerKey(providerIssuer(provider)) === key,
    );
    if (sharing.length > 1) {
      throw new Error(
        `Issuer "${member.issuer}" of ${owner} is also another provider's issuer. An issuer may belong to one provider only.`,
      );
    }
  }
  return all;
};

/**
 * `confect/_generated/auth.providers.ts`'s list: the static providers, then
 * each family issuer with its family and name. A family whose value is invalid
 * lists none of its issuers.
 */
export const providers = (
  statics: ReadonlyArray<Provider>,
  families: ReadonlyArray<Source>,
): ReadonlyArray<Provider> => [
  ...statics,
  ...Arr.flatMap(families, ({ family, key, value }) =>
    Result.match(parse(key, value), {
      onFailure: () => [],
      onSuccess: Arr.map(({ name, issuer, applicationID }): Provider =>
        applicationID === undefined
          ? { issuer, family, name }
          : { issuer, audience: applicationID, family, name },
      ),
    }),
  ),
];

export type Lookup<P> =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Provider"; readonly provider: P }
  | {
      readonly _tag: "Shared";
      readonly providers: readonly [P, P, ...Array<P>];
    };

/**
 * The provider for a verified identity's issuer, compared as Convex compares
 * issuers. An issuer that two providers share returns both, never one.
 */
export const lookup = <P extends { readonly issuer: string }>(
  list: ReadonlyArray<P>,
  issuer: string,
): Lookup<P> => {
  const [first, second, ...rest] = Arr.filter(
    list,
    (provider) => issuerKey(provider.issuer) === issuerKey(issuer),
  );
  if (first === undefined) return { _tag: "Unknown" };
  return second === undefined
    ? { _tag: "Provider", provider: first }
    : { _tag: "Shared", providers: [first, second, ...rest] };
};
