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

const rsaKeys = () =>
  Effect.promise(() =>
    crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    ),
  );

const sign = (key: CryptoKey, claims: Record<string, unknown>) =>
  Effect.promise(() => {
    const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: "test" })}.${encode(claims)}`;
    return crypto.subtle
      .sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned))
      .then(
        (signature) =>
          `${unsigned}.${Buffer.from(signature).toString("base64url")}`,
      );
  });

/**
 * Keys made in the test, the JWKS that declares one of them as a `data:` URL,
 * and the five verifier cases, each with a token minted at `nowSeconds`. The
 * foreign key signs under the declared key's `kid` and issuer.
 */
export const mint = (nowSeconds: number) =>
  Effect.gen(function* () {
    const declared = yield* rsaKeys();
    const foreign = yield* rsaKeys();
    const publicJwk = yield* Effect.promise(() =>
      crypto.subtle.exportKey("jwk", declared.publicKey),
    );
    const jwks = `data:application/json;base64,${Buffer.from(
      encodeJson({
        keys: [{ ...publicJwk, kid: "test", alg: "RS256", use: "sig" }],
      }),
    ).toString("base64")}`;
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
    return { jwks, cases };
  });
