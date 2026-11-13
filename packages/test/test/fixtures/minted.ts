/* oxlint-disable confect/no-schema-codec-wrappers, effecttsgo/schema-sync -- #134 (the JWT row) wrote this file before main moved to the Effect 4.1 lint rules. #134 brings it to those rules when it merges main, so row 7 leaves its code as #134 has it rather than rewrite it twice. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * The provider the local-backend fixture's `auth.config.ts` declares. The
 * kernel cases declare the same one.
 */
export const provider = {
  type: "customJwt",
  issuer: "https://confect-auth.invalid",
  applicationID: "confect-test",
  algorithm: "RS256",
} as const;

/**
 * What a verifier did with a token, in one shape for both targets. A refusal is
 * the transport's: the token never reached a function. `code` is the binary's:
 * `NoAuthProvider` when no provider's issuer and audience match, and
 * `InvalidAuthHeader` for every other failure.
 */
export type VerifierOutcome =
  | { readonly _tag: "accepted"; readonly identity: object }
  | {
      readonly _tag: "refused";
      readonly refusal: "InvalidToken";
      readonly code: "NoAuthProvider" | "InvalidAuthHeader";
    };

export interface VerifierCase {
  readonly name:
    | "valid control"
    | "wrong issuer"
    | "wrong audience"
    | "foreign key"
    | "expired";
  readonly token: string;
  readonly expected: VerifierOutcome;
}

const encode = (value: unknown) =>
  Buffer.from(encodeJson(value)).toString("base64url");

export const rsaKeys = (modulusLength = 2048) =>
  Effect.promise(() =>
    crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    ),
  );

const signatureAlgorithms = {
  RS256: "RSASSA-PKCS1-v1_5",
  ES256: { name: "ECDSA", hash: "SHA-256" },
} as const;

/**
 * A token over `claims` under `kid` "test", signed by `key` with `alg`.
 */
export const sign = (
  key: CryptoKey,
  claims: Record<string, unknown>,
  alg: keyof typeof signatureAlgorithms = "RS256",
) =>
  Effect.promise(() => {
    const unsigned = `${encode({ alg, typ: "JWT", kid: "test" })}.${encode(claims)}`;
    return crypto.subtle
      .sign(signatureAlgorithms[alg], key, new TextEncoder().encode(unsigned))
      .then(
        (signature) =>
          `${unsigned}.${Buffer.from(signature).toString("base64url")}`,
      );
  });

/**
 * A JWKS of `keys` as a base64 `data:` URL.
 */
export const jwksUrl = (keys: ReadonlyArray<object>) =>
  `data:application/json;base64,${Buffer.from(encodeJson({ keys })).toString("base64")}`;

/**
 * Keys made in the test, the JWKS that declares one of them as a `data:` URL,
 * and the five verifier cases, each with a token minted at `nowSeconds`. The
 * foreign key signs under the declared key's `kid` and issuer. `signDeclared`
 * signs the valid control's claims with overrides.
 */
export const mint = (nowSeconds: number) =>
  Effect.gen(function* () {
    const declared = yield* rsaKeys();
    const foreign = yield* rsaKeys();
    const publicJwk = yield* Effect.promise(() =>
      crypto.subtle.exportKey("jwk", declared.publicKey),
    );
    const jwks = jwksUrl([
      { ...publicJwk, kid: "test", alg: "RS256", use: "sig" },
    ]);
    const claims = {
      iss: provider.issuer,
      aud: provider.applicationID,
      sub: "person",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      name: "Synthetic Person",
      role: "student",
    };
    const refused = (code: "NoAuthProvider" | "InvalidAuthHeader") =>
      ({ _tag: "refused", refusal: "InvalidToken", code }) as const;
    const cases: ReadonlyArray<VerifierCase> = [
      {
        name: "valid control",
        token: yield* sign(declared.privateKey, claims),
        expected: {
          _tag: "accepted",
          identity: {
            issuer: provider.issuer,
            subject: "person",
            tokenIdentifier: `${provider.issuer}|person`,
            name: "Synthetic Person",
            role: "student",
          },
        },
      },
      {
        name: "wrong issuer",
        token: yield* sign(declared.privateKey, {
          ...claims,
          iss: "https://foreign.invalid",
        }),
        expected: refused("NoAuthProvider"),
      },
      {
        name: "wrong audience",
        token: yield* sign(declared.privateKey, {
          ...claims,
          aud: "another-app",
        }),
        expected: refused("NoAuthProvider"),
      },
      {
        name: "foreign key",
        token: yield* sign(foreign.privateKey, claims),
        expected: refused("InvalidAuthHeader"),
      },
      {
        name: "expired",
        token: yield* sign(declared.privateKey, {
          ...claims,
          iat: nowSeconds - 3600,
          exp: nowSeconds - 60,
        }),
        expected: refused("InvalidAuthHeader"),
      },
    ];
    return {
      jwks,
      cases,
      claims,
      signDeclared: (overrides: Record<string, unknown>) =>
        sign(declared.privateKey, { ...claims, ...overrides }),
    };
  });
