import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { identified, type TokenReview } from "./tokenReview";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

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
  /**
   * What an HTTP action's handler sees of the same token when the verifier's
   * clock reads `atSeconds`. The binary refuses none: a refused token's error
   * waits for `getUserIdentity`, as a plain `Error` with the verifier's
   * message, which for an expired token counts the seconds since it expired.
   */
  readonly review: (atSeconds: number) => TokenReview;
}

const encode = (value: unknown) =>
  Effect.map(Schema.encodeEffect(UnknownJson)(value), (json) =>
    Buffer.from(json).toString("base64url"),
  );

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
  Effect.gen(function* () {
    const header = yield* encode({ alg, typ: "JWT", kid: "test" });
    const payload = yield* encode(claims);
    const unsigned = `${header}.${payload}`;
    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign(
        signatureAlgorithms[alg],
        key,
        new TextEncoder().encode(unsigned),
      ),
    );
    return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  });

/**
 * A JWKS of `keys` as a base64 `data:` URL.
 */
export const jwksUrl = (keys: ReadonlyArray<object>) =>
  Effect.map(
    Schema.encodeEffect(UnknownJson)({ keys }),
    (json) =>
      `data:application/json;base64,${Buffer.from(json).toString("base64")}`,
  );

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
    const jwks = yield* jwksUrl([
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
    // The binary's messages for this provider and these tokens
    // (`authentication/src/lib.rs:66-105`, `:327-351`, `:408-418`,
    // `biscuit/src/errors.rs:213`).
    const threw = (message: string): TokenReview => ({
      _tag: "threw",
      errorClass: "Error",
      hasData: false,
      message,
    });
    const noProvider = threw(
      `No auth provider found matching the given token. Check that your JWT's issuer and audience match one of your configured providers: [CustomJWT(issuer=${provider.issuer}, app_id=${provider.applicationID})]`,
    );
    const identity = {
      issuer: provider.issuer,
      subject: "person",
      tokenIdentifier: `${provider.issuer}|person`,
      name: "Synthetic Person",
      role: "student",
    };
    const cases: ReadonlyArray<VerifierCase> = [
      {
        name: "valid control",
        token: yield* sign(declared.privateKey, claims),
        expected: { _tag: "accepted", identity },
        review: () => identified(identity),
      },
      {
        name: "wrong issuer",
        token: yield* sign(declared.privateKey, {
          ...claims,
          iss: "https://foreign.invalid",
        }),
        expected: refused("NoAuthProvider"),
        review: () => noProvider,
      },
      {
        name: "wrong audience",
        token: yield* sign(declared.privateKey, {
          ...claims,
          aud: "another-app",
        }),
        expected: refused("NoAuthProvider"),
        review: () => noProvider,
      },
      {
        name: "foreign key",
        token: yield* sign(foreign.privateKey, claims),
        expected: refused("InvalidAuthHeader"),
        review: () =>
          threw(
            "Could not decode token. The JWT's 'kid' (key ID) header is 'test', does this key match any key in the provider's JWKS?",
          ),
      },
      {
        name: "expired",
        token: yield* sign(declared.privateKey, {
          ...claims,
          iat: nowSeconds - 3600,
          exp: nowSeconds - 60,
        }),
        expected: refused("InvalidAuthHeader"),
        review: (atSeconds) =>
          threw(
            `Could not validate token: Token expired ${atSeconds - (nowSeconds - 60)} seconds ago`,
          ),
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
