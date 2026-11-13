import { getFunctionName } from "convex/server";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as LocalBackend from "./LocalBackend";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const Answer = Schema.Struct({
  status: Schema.Literal("success"),
  value: Schema.Unknown,
});

/**
 * A client's call over the HTTP API, as `ConvexHttpClient` sends it, with
 * `headers` added. The binary reads a call's identity, address and agent from
 * them (`ExtractRequestMetadata` in `crates/common/src/http/mod.rs:1062-1092`,
 * convex-backend `cccbade4`). Pass it to `Ref.runWithCodec`.
 */
export const send =
  (kind: "query" | "mutation" | "action", headers: Record<string, string>) =>
  (reference: any, args: unknown): Promise<unknown> =>
    HttpClientRequest.post(`${LocalBackend.cloudUrl()}/api/${kind}`).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyJsonUnsafe({
        path: getFunctionName(reference),
        format: "convex_encoded_json",
        args: [args],
      }),
      HttpClient.execute,
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Answer)),
      Effect.map((answer) => answer.value),
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise,
    );

/**
 * Point the fixture's `auth.config` at a fresh key, redeploy, and sign a token
 * for `subject` that it accepts.
 */
export const mintToken = (
  subject: string,
): Effect.Effect<string, never, LocalBackend.LocalBackend> =>
  Effect.gen(function* () {
  const backend = yield* LocalBackend.LocalBackend;
  const keys = yield* Effect.promise(() =>
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
  const key = yield* Effect.promise(() =>
    crypto.subtle.exportKey("jwk", keys.publicKey),
  );
  const jwks = { keys: [{ ...key, kid: "test", alg: "RS256", use: "sig" }] };
  yield* backend.setEnv(
    "TEST_AUTH_JWKS",
    `data:application/json;base64,${Buffer.from(encodeJson(jwks)).toString("base64")}`,
  );
  yield* backend.redeploy;
  const encode = (value: unknown) =>
    Buffer.from(encodeJson(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", kid: "test" })}.${encode({
    iss: "https://confect-auth.invalid",
    aud: "confect-test",
    sub: subject,
    exp: Math.floor((yield* Clock.currentTimeMillis) / 1000) + 3600,
  })}`;
  const signature = yield* Effect.promise(() =>
    crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(unsigned),
    ),
  );
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  }).pipe(Effect.orDie);
