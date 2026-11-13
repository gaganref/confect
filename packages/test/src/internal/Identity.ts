// The deployment signer's validation (`DeploymentKey.sign`) is derived from
// convex-test 0.0.65 (index.ts), Copyright Convex, Inc., licensed under the
// Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Its key and signatures come from @noble/curves. The verifier follows the
// binary's `validate_id_token`, cited at each rule.

import { p256 } from "@noble/curves/nist.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { UserIdentity } from "convex/server";
import * as KernelRefusal from "./KernelRefusal.js";
import { base64UrlEncode, base64UrlEncodeBytes } from "./KernelValues.js";

// Read once at load, outside any invocation's pinned copy of `crypto`.
const subtle = globalThis.crypto.subtle;

type Algorithm = "RS256" | "ES256";

/**
 * One provider of the app's `auth.config`, in the binary's `SerializedAuthInfo`
 * shape (`common/src/auth.rs:120-139`).
 */
export type Provider =
  | {
      readonly type: "customJwt";
      readonly issuer: string;
      readonly applicationID: string | undefined;
      readonly jwks: string;
      readonly algorithm: Algorithm;
    }
  | {
      readonly type: "oidc";
      readonly domain: string;
      readonly applicationID: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidConfig = (index: number, reason: string) =>
  KernelRefusal.InvalidAuthConfig.make({
    index,
    message: `auth.config providers[${index}] ${reason}`,
  });

/**
 * A provider's issuer or domain as the binary stores it: `https://` is added
 * when the value has no scheme (`deserialize_issuer_url`,
 * `common/src/auth.rs:209-241`).
 */
const configuredIssuer = (url: string) =>
  /^\w+:\/\//.test(url) ? url : `https://${url}`;

/**
 * The providers an `auth.config` module's default export declares. A
 * `customJwt` provider needs a string issuer and JWKS and an RS256 or ES256
 * algorithm. Any other entry is an OIDC provider and needs a string domain and
 * application ID. A provider the binary would refuse at push throws
 * `InvalidAuthConfig`.
 */
export const readProviders = (config: unknown): ReadonlyArray<Provider> => {
  if (config === undefined) return [];
  const providers = isRecord(config) ? config["providers"] : undefined;
  if (!Array.isArray(providers)) {
    throw KernelRefusal.InvalidAuthConfig.make({
      index: -1,
      message: "auth.config's default export has no providers array.",
    });
  }
  const read: Array<Provider> = [];
  for (const [index, provider] of providers.entries()) {
    if (!isRecord(provider)) throw invalidConfig(index, "is not an object.");
    const applicationID = provider["applicationID"];
    if (provider["type"] === "customJwt") {
      const { issuer, jwks, algorithm } = provider;
      if (typeof issuer !== "string" || typeof jwks !== "string") {
        throw invalidConfig(index, "needs a string issuer and jwks.");
      }
      if (algorithm !== "RS256" && algorithm !== "ES256") {
        throw invalidConfig(
          index,
          "has an algorithm other than RS256 or ES256.",
        );
      }
      if (applicationID !== undefined && typeof applicationID !== "string") {
        throw invalidConfig(index, "has a non-string applicationID.");
      }
      read.push({
        type: "customJwt",
        issuer: configuredIssuer(issuer),
        applicationID,
        jwks,
        algorithm,
      });
    } else {
      const { domain } = provider;
      if (typeof domain !== "string" || typeof applicationID !== "string") {
        throw invalidConfig(
          index,
          "is an OIDC provider without a string domain and applicationID.",
        );
      }
      read.push({
        type: "oidc",
        domain: configuredIssuer(domain),
        applicationID,
      });
    }
  }
  return read;
};

const refuse = (
  code: KernelRefusal.InvalidToken["code"],
  message: string,
): KernelRefusal.InvalidToken =>
  KernelRefusal.InvalidToken.make({ code, message });

const invalid = (message: string) => refuse("InvalidAuthHeader", message);

/**
 * The registered claims, typed as the binary's `RegisteredClaims` reads them,
 * and the rest as the private claims.
 */
interface Claims {
  readonly iss: string | undefined;
  readonly sub: string | undefined;
  readonly aud: ReadonlyArray<string> | undefined;
  readonly exp: number | undefined;
  readonly nbf: number | undefined;
  readonly iat: number | undefined;
  readonly private: Record<string, unknown>;
}

const registered = new Set(["iss", "sub", "aud", "exp", "nbf", "iat", "jti"]);

const decodeBytes = (part: string | undefined): Uint8Array | undefined => {
  if (part === undefined || !/^[\w-]*$/.test(part)) return undefined;
  try {
    const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const decodePart = (part: string | undefined): unknown => {
  const bytes = decodeBytes(part);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
};

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
/**
 * A timestamp as `biscuit`'s `numeric_type` reads it: a number from 0 up to
 * 2^64, rounded to the nearest second. A negative or larger number fails the
 * payload (`biscuit/src/serde_custom/numeric_type.rs:52-91`,
 * `biscuit/src/lib.rs:719-732`).
 */
const time = (value: unknown) =>
  typeof value === "number" && value >= 0 && value < 2 ** 64
    ? Math.round(value)
    : undefined;
const audienceList = (value: unknown) =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((a) => typeof a === "string")
      ? (value as ReadonlyArray<string>)
      : undefined;

/**
 * A claim that is absent or `null` reads as `undefined`. One of the wrong type
 * fails the whole payload.
 */
const claim = <A>(
  payload: Record<string, unknown>,
  name: string,
  read: (value: unknown) => A | undefined,
): A | undefined | null => {
  const value = payload[name];
  return value === undefined || value === null
    ? undefined
    : (read(value) ?? null);
};

const readClaims = (part: string | undefined): Claims | undefined => {
  const payload = decodePart(part);
  if (!isRecord(payload)) return undefined;
  const claims = {
    iss: claim(payload, "iss", text),
    sub: claim(payload, "sub", text),
    aud: claim(payload, "aud", audienceList),
    exp: claim(payload, "exp", time),
    nbf: claim(payload, "nbf", time),
    iat: claim(payload, "iat", time),
  };
  const jti = claim(payload, "jti", text);
  if (jti === null || Object.values(claims).includes(null)) return undefined;
  return {
    ...(claims as {
      [K in keyof typeof claims]: Exclude<(typeof claims)[K], null>;
    }),
    private: Object.fromEntries(
      Object.entries(payload).filter(([name]) => !registered.has(name)),
    ),
  };
};

/**
 * Whether a token's issuer names a provider's: `https://` is added to a token
 * issuer without a scheme and trailing slashes are ignored on both sides
 * (`matches_token`, `common/src/auth.rs:66-81`).
 */
const sameIssuer = (tokenIssuer: string, issuer: string) =>
  (/^https?:\/\//.test(tokenIssuer)
    ? tokenIssuer
    : `https://${tokenIssuer}`
  ).replace(/\/+$/, "") === issuer.replace(/\/+$/, "");

const providerIssuer = (provider: Provider) =>
  provider.type === "customJwt" ? provider.issuer : provider.domain;

/**
 * A provider matches when its issuer does and, if it names an application ID,
 * the token's audiences include it (`common/src/auth.rs:48-64`).
 */
const matches = (
  provider: Provider,
  audiences: ReadonlyArray<string>,
  issuer: string,
) =>
  (provider.applicationID === undefined ||
    audiences.includes(provider.applicationID)) &&
  sameIssuer(issuer, providerIssuer(provider));

const noProviderMessage = (providers: ReadonlyArray<Provider>) =>
  providers.length === 0
    ? "No auth provider found matching the given token (no providers configured). Check convex/auth.config.ts."
    : `No auth provider found matching the given token. Check that your JWT's issuer and audience match one of your configured providers: [${providers
        .map((provider) =>
          provider.type === "customJwt"
            ? `CustomJWT(issuer=${provider.issuer}, app_id=${provider.applicationID ?? "none"})`
            : `OIDC(domain=${provider.domain}, app_id=${provider.applicationID})`,
        )
        .join(", ")}]`;

/**
 * The text of a `data:` URL, decoded as the binary's `data-url` crate 0.3.1
 * decodes a JWKS (`authentication/src/lib.rs:445-456`). Tabs and newlines are
 * ignored. The media type ends at the first comma, which must come before any
 * `#`. The body stops at the first `#`, so a fragment is dropped, and is
 * percent-decoded, then base64-decoded when the media type ends `;base64`
 * (`data-url/src/lib.rs:73-120`, `:158-200`, `:283-353`). `undefined` for a URL
 * of another scheme. A data URL that does not decode throws.
 */
const dataUrlBody = (url: string): string | undefined => {
  const input = url.replace(/^[\0-\x20]+/, "").replace(/[\t\n\r]/g, "");
  if (!/^data:/i.test(input)) return undefined;
  const afterColon = input.slice("data:".length).replace(/[\0-\x20]+$/, "");
  const comma = afterColon.search(/[,#]/);
  if (comma === -1 || afterColon[comma] !== ",") {
    throw new Error("A data URL needs a comma before its body.");
  }
  const mediaType = afterColon.slice(0, comma).trim();
  const binary = afterColon
    .slice(comma + 1)
    .split("#", 1)[0]!
    .replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  // `atob` is the forgiving-base64 decode the crate implements.
  const decoded = /; *base64$/i.test(mediaType) ? atob(binary) : binary;
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(decoded, (char) => char.charCodeAt(0)),
  );
};

const importParameters = {
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
} as const;

const verifyParameters = {
  RS256: { name: "RSASSA-PKCS1-v1_5" },
  ES256: { name: "ECDSA", hash: "SHA-256" },
} as const;

/**
 * An unsigned big-endian integer's bytes without leading zeros, as `biscuit`
 * reads a JWK's `n` and `e` into a `BigUint`.
 */
const unsigned = (part: unknown): Uint8Array | undefined => {
  const bytes = typeof part === "string" ? decodeBytes(part) : undefined;
  if (bytes === undefined) return undefined;
  const first = bytes.findIndex((byte) => byte !== 0);
  return first === -1 ? new Uint8Array() : bytes.subarray(first);
};

const bitLength = (bytes: Uint8Array) =>
  bytes.length === 0
    ? 0
    : (bytes.length - 1) * 8 + (32 - Math.clz32(bytes[0]!));

/**
 * Whether `ring` 0.17.14, which `biscuit` verifies RS256 with as
 * `RSA_PKCS1_2048_8192_SHA256` (`biscuit/src/jwa.rs:368-445`), takes this
 * public key. The modulus is odd, over 2,040 bits rounded up to whole bytes and
 * at most 8,192 (`ring/src/rsa/public_modulus.rs:47-71`,
 * `ring/src/arithmetic/bigint/modulusvalue.rs:42-67`). The exponent is odd, at
 * most five bytes, and from 3 to 2^33 - 1
 * (`ring/src/rsa/public_exponent.rs:46-80`,
 * `ring/src/rsa/verification.rs:205-219`).
 */
const ringTakesRsa = (n: Uint8Array, e: Uint8Array) => {
  const nBits = bitLength(n);
  if (nBits === 0 || n[n.length - 1]! % 2 === 0) return false;
  if (Math.ceil(nBits / 8) * 8 < 2048 || nBits > 8192) return false;
  if (e.length === 0 || e.length > 5) return false;
  const exponent = e.reduce((value, byte) => value * 256 + byte, 0);
  return exponent >= 3 && exponent <= 2 ** 33 - 1 && exponent % 2 === 1;
};

const encodeBytes = (bytes: Uint8Array) => base64UrlEncodeBytes(bytes);

/**
 * The key Web Crypto verifies with, holding only what `biscuit` reads, or
 * `undefined` for a key the binary would refuse for `algorithm`. RS256 needs an
 * RSA key `ring` takes. ES256 needs an EC key whose `x` and `y` are 32 bytes
 * each: `biscuit` passes `0x04 || x || y` to `ring`'s `ECDSA_P256_SHA256_FIXED`
 * and never reads `crv`, `use` or `key_ops` (`biscuit/src/jwk.rs:373-380`).
 */
const keyMaterial = (
  jwk: Record<string, unknown>,
  algorithm: Algorithm,
): JsonWebKey | undefined => {
  if (algorithm === "RS256") {
    const n = unsigned(jwk["n"]);
    const e = unsigned(jwk["e"]);
    return jwk["kty"] === "RSA" &&
      n !== undefined &&
      e !== undefined &&
      ringTakesRsa(n, e)
      ? { kty: "RSA", n: encodeBytes(n), e: encodeBytes(e) }
      : undefined;
  }
  const x = typeof jwk["x"] === "string" ? decodeBytes(jwk["x"]) : undefined;
  const y = typeof jwk["y"] === "string" ? decodeBytes(jwk["y"]) : undefined;
  return jwk["kty"] === "EC" && x?.length === 32 && y?.length === 32
    ? { kty: "EC", crv: "P-256", x: encodeBytes(x), y: encodeBytes(y) }
    : undefined;
};

/**
 * Checks the signature against the key the header's `kid` names, as `biscuit`'s
 * `decode_with_jwks` does with the provider's algorithm expected
 * (`biscuit/src/jws/compact.rs:142-212` at the binary's pinned revision). The
 * JWK's `alg`, when it has one, must equal the header's and the provider's.
 * Without one, the header's must equal the provider's.
 */
const signatureHolds = (
  parts: ReadonlyArray<string>,
  keys: ReadonlyArray<Record<string, unknown>>,
  expected: Algorithm,
): Promise<boolean> => {
  if (parts.length !== 3) return Promise.resolve(false);
  const header = decodePart(parts[0]);
  if (!isRecord(header) || typeof header["alg"] !== "string") {
    return Promise.resolve(false);
  }
  const kid = header["kid"];
  if (typeof kid !== "string") return Promise.resolve(false);
  const jwk = keys.find((key) => key["kid"] === kid);
  if (jwk === undefined) return Promise.resolve(false);
  const algorithm = jwk["alg"] ?? expected;
  if (header["alg"] !== algorithm || algorithm !== expected) {
    return Promise.resolve(false);
  }
  const material = keyMaterial(jwk, expected);
  const signature = decodeBytes(parts[2]);
  if (material === undefined || signature === undefined) {
    return Promise.resolve(false);
  }
  return subtle
    .importKey("jwk", material, importParameters[expected], false, ["verify"])
    .then((key) =>
      subtle.verify(
        verifyParameters[expected],
        key,
        signature as BufferSource,
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ),
    )
    .catch(() => false);
};

const decodeFailure = (token: string) => {
  const header = decodePart(token.split(".")[0]);
  const kid = isRecord(header) ? header["kid"] : undefined;
  return invalid(
    typeof kid === "string"
      ? `Could not decode token. The JWT's 'kid' (key ID) header is '${kid}', does this key match any key in the provider's JWKS?`
      : "Could not decode token. JWT may be missing a 'kid' (key ID) header.",
  );
};

/**
 * How far a token's times may be off: five seconds
 * (`authentication/src/lib.rs:401-407`), checked as `biscuit`'s `validate_exp`,
 * `validate_nbf` and `validate_iat` do (`biscuit/src/lib.rs:906-966`).
 */
const SKEW_SECONDS = 5;

const temporalFailure = (claims: Claims, now: number): string | undefined => {
  if (claims.exp !== undefined && now - claims.exp > SKEW_SECONDS) {
    return "Token expired";
  }
  if (claims.nbf !== undefined && claims.nbf - now > SKEW_SECONDS) {
    return "Token not yet valid (nbf)";
  }
  if (claims.iat !== undefined && claims.iat - now > SKEW_SECONDS) {
    return "Token issued in the future (iat)";
  }
  return undefined;
};

/**
 * A custom claim as the identity carries it: a nested object's leaves become
 * `outer.inner` keys and `fva` is dropped (`keybroker/src/broker.rs:530-536`,
 * `:681-695`).
 */
const flatten = (
  claims: Record<string, unknown>,
  prefix = "",
): Array<readonly [string, unknown]> =>
  Object.entries(claims).flatMap(([name, value]) =>
    isRecord(value)
      ? flatten(value, `${prefix}${name}.`)
      : [[`${prefix}${name}`, value] as const],
  );

/**
 * The identity a `customJwt` token gives a handler: its issuer, subject and
 * `tokenIdentifier`, plus every custom claim under its claim name. Standard
 * OIDC claim names such as `name` stay custom claims here, unlike an OIDC
 * provider's (`UserIdentity::from_custom_jwt`,
 * `keybroker/src/broker.rs:512-551`).
 */
const identityOf = (
  claims: Claims & { readonly iss: string; readonly sub: string },
): UserIdentity =>
  ({
    ...Object.fromEntries(
      flatten(claims.private).filter(([name]) => name !== "fva"),
    ),
    tokenIdentifier: `${claims.iss}|${claims.sub}`,
    issuer: claims.iss,
    subject: claims.sub,
  }) as UserIdentity;

/**
 * Verify a token a test presents as a client would, against the app's providers
 * at `nowMs`, by the rules of the binary's `validate_id_token`
 * (`authentication/src/lib.rs:142-436`, at `precompiled-2026-10-28-cccbade`).
 * The token's issuer and audience pick the first matching provider, or it is
 * refused `NoAuthProvider`. A `customJwt` provider's JWKS must be a `data:`
 * URL, so its keys are the test's. Every other failure is `InvalidAuthHeader`.
 * An OIDC provider's discovery and a JWKS fetched over the network stay on the
 * binary.
 */
export const verify = (
  token: string,
  providers: ReadonlyArray<Provider>,
  nowMs: number,
): Promise<UserIdentity> => {
  const now = Math.floor(nowMs / 1000);
  const parts = token.split(".");
  const unverified = readClaims(parts[1]);
  if (unverified === undefined) {
    return Promise.reject(
      invalid(
        "Could not parse JWT payload. Check that the token is a valid JWT format with three base64-encoded parts separated by dots.",
      ),
    );
  }
  if (unverified.iss === undefined) {
    return Promise.reject(
      invalid(
        "Missing issuer claim ('iss') in JWT payload. The JWT must include an 'iss' claim that matches one of your configured auth providers.",
      ),
    );
  }
  const issuer = unverified.iss;
  const provider = providers.find((candidate) =>
    matches(candidate, unverified.aud ?? [], issuer),
  );
  if (provider === undefined) {
    return Promise.reject(
      refuse("NoAuthProvider", noProviderMessage(providers)),
    );
  }
  if (provider.type === "oidc") {
    return Promise.reject(KernelRefusal.requiresBinary("oidcDiscovery"));
  }
  let body: string | undefined;
  try {
    body = dataUrlBody(provider.jwks);
  } catch {
    return Promise.reject(
      invalid(
        "Invalid JWKS data URL. Check that the data URL is properly formatted and contains valid base64-encoded JSON.",
      ),
    );
  }
  if (body === undefined) {
    return Promise.reject(KernelRefusal.requiresBinary("remoteJwks"));
  }
  let keys: ReadonlyArray<Record<string, unknown>>;
  try {
    const jwks: unknown = JSON.parse(body);
    const listed = isRecord(jwks) ? jwks["keys"] : undefined;
    if (!Array.isArray(listed) || !listed.every(isRecord)) throw listed;
    keys = listed;
  } catch {
    return Promise.reject(
      invalid(
        `Invalid JWKS response body from '${provider.jwks}'. The response is not valid JSON or doesn't match the expected JWKS format.`,
      ),
    );
  }
  return signatureHolds(parts, keys, provider.algorithm).then((holds) => {
    const claims = holds ? readClaims(parts[1]) : undefined;
    if (claims === undefined) throw decodeFailure(token);
    if (claims.iss === undefined || !sameIssuer(claims.iss, provider.issuer)) {
      throw invalid(`Invalid issuer: ${claims.iss} != ${provider.issuer}`);
    }
    if (provider.applicationID !== undefined) {
      if (claims.aud === undefined) {
        throw invalid(
          "Missing audience claim ('aud') in JWT payload. The JWT must include an 'aud' claim that matches your configured application ID.",
        );
      }
      if (!claims.aud.includes(provider.applicationID)) {
        throw invalid(
          `Invalid audience: ${provider.applicationID} not in ${JSON.stringify(claims.aud)}`,
        );
      }
    }
    const temporal = temporalFailure(claims, now);
    if (temporal !== undefined) {
      throw invalid(`Could not validate token: ${temporal}`);
    }
    if (claims.sub === undefined) throw invalid("Missing subject");
    if (claims.exp === undefined) throw invalid("Missing expiry");
    return identityOf({ ...claims, iss: claims.iss, sub: claims.sub });
  });
};

// Limits the backend puts on tokens from `ctx.auth.signJwt`.
const DEPLOYMENT_JWT_MAX_LIFETIME_SECONDS = 60 * 60;
const DEPLOYMENT_JWT_MAX_SIZE = 8000;
const RESERVED_JWT_CLAIM_PREFIXES = ["convex", "cvx"];
// Used as the `iss` origin when the test environment doesn't set
// `CONVEX_CLOUD_URL`, which the backend always does.
const DEFAULT_CONVEX_CLOUD_URL = "https://some-deployment.convex.cloud";

// oxlint-disable-next-line effecttsgo/process-env -- As in convex-test, the test process's CONVEX_CLOUD_URL stands for the deployment's.
const cloudUrl = () => process.env["CONVEX_CLOUD_URL"];

interface DeploymentJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: "ES256";
  readonly use: "sig";
}

interface Derived {
  readonly secretKey: Uint8Array;
  readonly jwk: DeploymentJwk;
}

const KEY_LABEL = new TextEncoder().encode("deployment jwt signing key");

/**
 * The P-256 key the seed gives, as the binary derives its own from the
 * deployment's root secret: an HMAC of the label, generation 0 and an attempt
 * counter, retried while the scalar is out of range
 * (`keybroker/src/deployment_jwt.rs:162-176`). The `kid` is the key's RFC 7638
 * thumbprint (`:337-346`).
 */
const derive = (seed: Uint8Array): Derived => {
  for (let attempt = 0; attempt <= 255; attempt++) {
    const label = new Uint8Array(KEY_LABEL.length + 5);
    label.set(KEY_LABEL);
    label[label.length - 1] = attempt;
    const secretKey = hmac(sha256, seed, label);
    if (!p256.utils.isValidSecretKey(secretKey)) continue;
    const point = p256.getPublicKey(secretKey, false);
    const x = base64UrlEncodeBytes(point.subarray(1, 33));
    const y = base64UrlEncodeBytes(point.subarray(33, 65));
    const kid = base64UrlEncodeBytes(
      sha256(
        new TextEncoder().encode(
          `{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`,
        ),
      ),
    );
    return {
      secretKey,
      jwk: { kty: "EC", crv: "P-256", x, y, kid, alg: "ES256", use: "sig" },
    };
  }
  throw new Error("Could not derive a valid P-256 key");
};

/**
 * One test backend's deployment signing key, derived on first use from 32 bytes
 * drawn from the kernel runtime's random stream, never the host's. It signs
 * what `ctx.auth.signJwt` mints by RFC 6979, so a replay of one history signs
 * the same tokens. The binary's signer draws a random nonce (`:308`), which no
 * verifier can tell from a deterministic one. Its public half is the
 * deployment's JWKS.
 */
export class DeploymentKey {
  private derived: Derived | undefined;

  constructor(private readonly random: () => number) {}

  /**
   * Whether the key was drawn: a token was signed or the JWKS was served.
   */
  get drawn(): boolean {
    return this.derived !== undefined;
  }

  private key(): Derived {
    this.derived ??= derive(
      Uint8Array.from({ length: 32 }, () => Math.floor(this.random() * 256)),
    );
    return this.derived;
  }

  /**
   * What the backend serves at `${CONVEX_CLOUD_URL}/.well-known/jwks.json`.
   */
  jwks(): Promise<{ readonly keys: ReadonlyArray<DeploymentJwk> }> {
    return Promise.resolve({ keys: [{ ...this.key().jwk }] });
  }

  /**
   * The backend's `ctx.auth.signJwt`, with its validation, at `nowMs`, the
   * mutation's start time, as the binary signs at the function's timestamp
   * (`isolate/src/environment/udf/async_syscall.rs:1149-1179`). The app signs
   * under the deployment's origin and a component under
   * `{origin}/components/{path}`.
   */
  sign(
    componentPath: string,
    options: unknown,
    nowMs: number,
  ): Promise<string> {
    // On the backend the options cross the syscall boundary as JSON.
    const { claims = {}, expiresInSeconds } = JSON.parse(
      JSON.stringify(options ?? {}),
    );
    if (
      typeof claims !== "object" ||
      claims === null ||
      Array.isArray(claims)
    ) {
      return Promise.reject(
        new Error(
          "Invalid arguments for auth.signJwt: claims must be an object",
        ),
      );
    }
    if (typeof expiresInSeconds !== "number" || expiresInSeconds < 1) {
      return Promise.reject(
        new Error(
          "Invalid arguments for auth.signJwt: expiresInSeconds must be a number of seconds, at least 1",
        ),
      );
    }
    for (const reserved of ["iss", "iat", "exp"]) {
      if (Object.hasOwn(claims, reserved)) {
        return Promise.reject(
          new Error(
            `The '${reserved}' claim is set by Convex and can't be provided`,
          ),
        );
      }
    }
    const reservedPrefixClaim = Object.keys(claims).find((name) =>
      RESERVED_JWT_CLAIM_PREFIXES.some(
        (prefix) =>
          name.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase(),
      ),
    );
    if (reservedPrefixClaim !== undefined) {
      return Promise.reject(
        new Error(
          `The '${reservedPrefixClaim}' claim can't be provided: claim names ` +
            `starting with 'convex' or 'cvx' are reserved`,
        ),
      );
    }
    if (
      Object.hasOwn(claims, "sub") &&
      (typeof claims.sub !== "string" || claims.sub === "")
    ) {
      return Promise.reject(
        new Error("The 'sub' claim must be a non-empty string"),
      );
    }
    if (Object.hasOwn(claims, "nbf")) {
      return Promise.reject(
        new Error(
          "The 'nbf' claim is reserved by Convex and can't be provided",
        ),
      );
    }
    // The backend truncates the lifetime to whole seconds.
    const expiresIn = Math.floor(expiresInSeconds);
    if (expiresIn > DEPLOYMENT_JWT_MAX_LIFETIME_SECONDS) {
      return Promise.reject(
        new Error(
          `expiresIn must be between 1 second and ${DEPLOYMENT_JWT_MAX_LIFETIME_SECONDS} seconds`,
        ),
      );
    }
    const origin = (cloudUrl() || DEFAULT_CONVEX_CLOUD_URL).replace(/\/+$/, "");
    const issuedAt = Math.floor(nowMs / 1000);
    const payload = {
      ...claims,
      iss:
        componentPath === "" ? origin : `${origin}/components/${componentPath}`,
      iat: issuedAt,
      exp: issuedAt + expiresIn,
    };
    const { secretKey, jwk } = this.key();
    const signingInput =
      base64UrlEncode(
        JSON.stringify({ alg: "ES256", typ: "JWT", kid: jwk.kid }),
      ) +
      "." +
      base64UrlEncode(JSON.stringify(payload));
    // `p256.sign` hashes with SHA-256 and takes its nonce by RFC 6979.
    const signature = p256.sign(
      new TextEncoder().encode(signingInput),
      secretKey,
    );
    const token = `${signingInput}.${base64UrlEncodeBytes(signature)}`;
    if (token.length > DEPLOYMENT_JWT_MAX_SIZE) {
      return Promise.reject(
        new Error(
          `The token is ${token.length} bytes, over the ${DEPLOYMENT_JWT_MAX_SIZE} byte limit`,
        ),
      );
    }
    return Promise.resolve(token);
  }
}
