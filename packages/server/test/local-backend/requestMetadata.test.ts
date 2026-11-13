import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import { getFunctionName } from "convex/server";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  client,
  expected,
  normalize,
  type Observed,
} from "../../../test/test/fixtures/requestProbe";
import refs from "./fixtures/confect/_generated/refs";
import { Recorded } from "./fixtures/confect/groups/requests.spec";
import * as LocalBackend from "./LocalBackend";

const requests = refs.public.groups.requests;
const decodeRecorded = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Recorded),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const Answer = Schema.Struct({
  status: Schema.Literal("success"),
  value: Schema.Unknown,
});

/**
 * A client's call over the HTTP API, as `ConvexHttpClient` sends it, with the
 * headers the binary reads its request metadata from (`ExtractRequestMetadata`
 * in `crates/common/src/http/mod.rs:1062-1092`, convex-backend `cccbade4`).
 */
const send =
  (kind: "query" | "mutation" | "action", headers: Record<string, string>) =>
  (reference: any, args: unknown): Promise<unknown> =>
    fetch(`http://127.0.0.1:3210/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: encodeJson({
        path: getFunctionName(reference),
        format: "convex_encoded_json",
        args: [args],
      }),
    })
      .then((response) => response.json())
      .then((body) => Schema.decodeUnknownSync(Answer)(body).value);

/**
 * A token the fixture's `auth.config` accepts once its JWKS is the minted
 * key's.
 */
const mintToken = Effect.gen(function* () {
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
  yield* backend.setEnv(
    "TEST_AUTH_JWKS",
    `data:application/json;base64,${Buffer.from(encodeJson({ keys: [{ ...key, kid: "test", alg: "RS256", use: "sig" }] })).toString("base64")}`,
  );
  yield* backend.redeploy;
  const encode = (value: unknown) =>
    Buffer.from(encodeJson(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", kid: "test" })}.${encode({
    iss: "https://confect-auth.invalid",
    aud: "confect-test",
    sub: client.subject,
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
});

layer(LocalBackend.layer, {
  timeout: "120 seconds",
  excludeTestServices: true,
})("request metadata on a real backend", (it) => {
  it.effect(
    "gives each client call its own request, carries it into nested calls, and starts each job fresh with its ID",
    () =>
      Effect.gen(function* () {
        const token = yield* mintToken;
        const headers = {
          authorization: `Bearer ${token}`,
          "x-forwarded-for": client.ip,
          "user-agent": client.userAgent,
        };
        const caseId = `binary-${yield* Clock.currentTimeMillis}`;
        const mutation = yield* Ref.runWithCodec(
          requests.mutation,
          {},
          send("mutation", headers),
        );
        const action = yield* Ref.runWithCodec(
          requests.action,
          {},
          send("action", headers),
        );
        const schedule = yield* Ref.runWithCodec(
          requests.schedule,
          { caseId },
          send("mutation", headers),
        );
        // The scheduler runs both jobs on its own; wait for both records.
        const recorded = yield* Ref.runWithCodec(
          requests.recorded,
          { caseId },
          send("query", {}),
        ).pipe(
          Effect.filterOrFail((rows) => rows.length === 2),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
        );
        const observed: Observed = {
          mutation,
          action,
          schedule,
          scheduled: yield* Effect.forEach(recorded, (row) =>
            decodeRecorded(row),
          ),
        };
        expect(normalize(observed, { ...client, token })).toEqual(expected);
      }),
  );
});
