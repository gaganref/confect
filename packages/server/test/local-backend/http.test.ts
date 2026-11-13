import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as SignedEnvelope from "../signedEnvelope";
import * as LocalBackend from "./LocalBackend";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const LogEntry = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.String,
    udfType: Schema.String,
    identifier: Schema.String,
    timestamp: Schema.Finite,
  }),
);

layer(
  Layer.mergeAll(LocalBackend.layer, NodeServices.layer, FetchHttpClient.layer),
  { timeout: "120 seconds", excludeTestServices: true },
)("HTTP routes on a real backend", (it) => {
  it.effect(
    "logs reflected patterns for application and mounted component completions",
    () =>
      Effect.gen(function* () {
        const started = (yield* Clock.currentTimeMillis) / 1000;
        for (const requestPath of ["/users/42", "/first/members/42"]) {
          const response = yield* HttpClient.get(
            LocalBackend.siteUrl(requestPath),
          );
          expect(response.status).toBe(200);
          expect(yield* response.json).toBe("42");
        }
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner;
        const logs = yield* spawner.spawn(
          ChildProcess.make(
            "pnpm",
            ["convex", "logs", "--history", "100", "--success", "--jsonl"],
            {
              cwd: path.resolve(import.meta.dirname, "./fixtures"),
              shell: true,
              extendEnv: true,
              env: { CONVEX_AGENT_MODE: "anonymous" },
            },
          ),
        );
        const completions = yield* logs.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.startsWith("{")),
          Stream.mapEffect((line) => Schema.decodeEffect(LogEntry)(line)),
          Stream.filter(
            (entry) =>
              entry.kind === "Completion" &&
              entry.udfType === "HttpAction" &&
              entry.timestamp >= started,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("20 seconds"),
        );
        const labels = completions.map(({ identifier }) => identifier);
        expect(labels).toEqual(["GET /users/:id", "GET /members/:id"]);
        yield* Effect.sync(() => {
          for (const { kind, udfType, identifier } of completions) {
            process.stdout.write(`${kind} ${udfType} ${identifier}\n`);
          }
        });
      }),
  );
  // The kernel lane's `signedIngress.test.ts` expects these same answers from
  // the mock-backend fixture's copy of the route.
  it.effect(
    "answers a signed envelope's round trip, and refuses a tampered or non-UTF-8 one, as the test kernel does",
    () =>
      Effect.gen(function* () {
        const send = (body: Uint8Array, signature: string) =>
          HttpClient.execute(
            HttpClientRequest.post(
              LocalBackend.siteUrl(SignedEnvelope.path),
            ).pipe(
              HttpClientRequest.setHeader(
                SignedEnvelope.signatureHeader,
                signature,
              ),
              HttpClientRequest.bodyUint8Array(body, "application/json"),
            ),
          ).pipe(
            Effect.flatMap((response) =>
              Effect.map(response.text, (text) => ({
                status: response.status,
                body: text,
              })),
            ),
          );
        const sign = (body: Uint8Array) =>
          Effect.promise(() => SignedEnvelope.sign(body));
        const accepted = new TextEncoder().encode(
          encodeJson({ id: "evt_1", event: "paid" }),
        );
        expect(yield* send(accepted, yield* sign(accepted))).toStrictEqual({
          status: 200,
          body: "accepted paid evt_1",
        });
        const tampered = Uint8Array.from(accepted);
        tampered[tampered.length - 2] ^= 1;
        expect(yield* send(tampered, yield* sign(accepted))).toStrictEqual(
          SignedEnvelope.refusals.badSignature,
        );
        const notUtf8 = Uint8Array.of(0x7b, 0xff, 0x7d);
        expect(yield* send(notUtf8, yield* sign(notUtf8))).toStrictEqual(
          SignedEnvelope.refusals.malformedJson,
        );
      }),
  );
  it.effect("keeps unmatched app and component responses in Effect", () =>
    Effect.gen(function* () {
      for (const requestPath of ["/no-such-route", "/first/no-such-route"]) {
        const response = yield* HttpClient.get(
          LocalBackend.siteUrl(requestPath),
        );
        expect(response.status).toBe(404);
        expect(yield* response.text).toBe("");
      }
    }),
  );
  it.effect("dispatches OPTIONS on app and component endpoints to Effect", () =>
    Effect.gen(function* () {
      for (const requestPath of ["/users/42", "/first/members/42"]) {
        const response = yield* HttpClient.execute(
          HttpClientRequest.make("OPTIONS")(
            LocalBackend.siteUrl(requestPath),
          ).pipe(
            HttpClientRequest.setHeader("Access-Control-Request-Method", "GET"),
          ),
        );
        expect([response.status, yield* response.text]).toEqual([404, ""]);
      }
    }),
  );
  it.effect(
    "reaches middleware on the short form of an optional prefix parameter",
    () =>
      Effect.gen(function* () {
        for (const requestPath of ["/prefix", "/first/prefix"]) {
          const response = yield* HttpClient.execute(
            HttpClientRequest.make("OPTIONS")(
              LocalBackend.siteUrl(requestPath),
            ),
          );
          expect([response.status, yield* response.text]).toEqual([
            200,
            "POST middleware",
          ]);
        }
      }),
  );
  it.effect("reads absent, valid and rejected HTTP identity", () =>
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
      const jwks = {
        keys: [{ ...key, kid: "test", alg: "RS256", use: "sig" }],
      };
      yield* backend.setEnv(
        "TEST_AUTH_JWKS",
        `data:application/json;base64,${Buffer.from(encodeJson(jwks)).toString("base64")}`,
      );
      yield* backend.redeploy;
      const issuer = "https://confect-auth.invalid";
      const expires =
        Math.floor((yield* Clock.currentTimeMillis) / 1000) + 3600;
      const encode = (value: unknown) =>
        Buffer.from(encodeJson(value)).toString("base64url");
      const sign = Effect.fnUntraced(function* (iss: string) {
        const unsigned = `${encode({ alg: "RS256", kid: "test" })}.${encode({ iss, aud: "confect-test", sub: "person", exp: expires, name: "Synthetic Person", role: "student" })}`;
        const signature = yield* Effect.promise(() =>
          crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            keys.privateKey,
            new TextEncoder().encode(unsigned),
          ),
        );
        return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
      });
      const valid = yield* sign(issuer);
      const signatureStart = valid.lastIndexOf(".") + 1;
      const badSignature =
        valid.slice(0, signatureStart) +
        (valid[signatureStart] === "A" ? "B" : "A") +
        valid.slice(signatureStart + 1);
      const foreign = yield* sign("https://foreign.invalid");
      const cases = [
        ["absent", undefined, { _tag: "Absent" }],
        [
          "valid",
          valid,
          {
            _tag: "Valid",
            identity: {
              issuer,
              subject: "person",
              tokenIdentifier: `${issuer}|person`,
              name: "Synthetic Person",
              role: "student",
            },
          },
        ],
        ["bad signature", badSignature, { _tag: "Invalid" }],
        ["foreign issuer", foreign, { _tag: "Invalid" }],
      ] as const;
      for (const [label, token, expected] of cases) {
        const response = yield* HttpClient.get(
          LocalBackend.siteUrl("/identity"),
          token === undefined
            ? {}
            : { headers: { authorization: `Bearer ${token}` } },
        );
        expect(response.status, label).toBe(200);
        expect(yield* response.json, label).toEqual(expected);
      }
    }),
  );
});
