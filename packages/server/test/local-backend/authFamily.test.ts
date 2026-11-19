import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import {
  jwksUrl,
  provider as person,
  rsaKeys,
  sign,
} from "../../../../tools/local-backend/fixtures/minted";
import * as LocalBackend from "confect-local-backend/LocalBackend";

const Answer = Schema.Struct({
  status: Schema.Literal("success"),
  value: Schema.Unknown,
});

const Refusal = Schema.Struct({ code: Schema.String });

const Peers = Schema.Record(Schema.String, Schema.String).pipe(
  Schema.Array,
  Schema.fromJsonString,
);

type Outcome =
  | { readonly _tag: "answered"; readonly value: unknown }
  | { readonly _tag: "refused"; readonly code: string };

const answered = (value: unknown): Outcome => ({ _tag: "answered", value });

const refusedWith = (code: string): Outcome => ({ _tag: "refused", code });

const noProvider = refusedWith("NoAuthProvider");

/**
 * A client's call as `ConvexHttpClient` sends it, so a refused token's status
 * and code are visible.
 */
const call = (kind: "query" | "action", path: string, token?: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(
      `${LocalBackend.cloudUrl(LocalBackend.ports.family)}/api/${kind}`,
    ).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        path,
        format: "convex_encoded_json",
        args: [{}],
      }),
    );
    const response = yield* HttpClient.execute(
      token === undefined
        ? request
        : HttpClientRequest.bearerToken(request, token),
    );
    const body = yield* response.json;
    if (response.status === 401) {
      const { code } = yield* Schema.decodeUnknownEffect(Refusal)(body);
      return refusedWith(code);
    }
    const { value } = yield* Schema.decodeUnknownEffect(Answer)(body);
    return answered(value);
  });

/**
 * The peers the query and both Node actions read, with no token.
 */
const peersEverywhere = Effect.all({
  query: call("query", "peers:read"),
  nodeOne: call("action", "peersNodeOne:read"),
  nodeTwo: call("action", "peersNodeTwo:read"),
});

const everywhere = (peers: ReadonlyArray<string>) => ({
  query: answered({ peers, caller: null }),
  nodeOne: answered(peers),
  nodeTwo: answered(peers),
});

const platformIssuer = "https://platform.confect.invalid";
const billingIssuer = "https://billing.confect.invalid";
const audience = "confect-family";

/**
 * Two peers, each with its own key, a JWKS that declares it, and a token it
 * signs for itself.
 */
const mintPeers = Effect.gen(function* () {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const peer = (issuer: string) =>
    Effect.gen(function* () {
      const keys = yield* rsaKeys();
      const publicJwk = yield* Effect.promise(() =>
        crypto.subtle.exportKey("jwk", keys.publicKey),
      );
      const jwks = yield* jwksUrl([
        { ...publicJwk, kid: "test", alg: "RS256", use: "sig" },
      ]);
      const token = yield* sign(keys.privateKey, {
        iss: issuer,
        aud: audience,
        sub: "service",
        iat: now,
        exp: now + 3600,
      });
      return { jwks, token };
    });
  const platform = yield* peer(platformIssuer);
  const billing = yield* peer(billingIssuer);
  return { platform, billing };
});

/**
 * Set `PEER_SERVICES` to `members` with no push, as an operator changes a
 * deployment's env.
 */
const setPeers = (
  backend: LocalBackend.LocalBackend["Service"],
  members: ReadonlyArray<Readonly<Record<string, string>>>,
) =>
  Schema.encodeEffect(Peers)(members).pipe(
    Effect.flatMap((value) => backend.setEnv("PEER_SERVICES", value)),
  );

layer(
  Layer.mergeAll(
    LocalBackend.familyLayer,
    NodeServices.layer,
    FetchHttpClient.layer,
  ),
  { timeout: "120 seconds", excludeTestServices: true },
)("A provider family on a real backend", (it) => {
  it.effect(
    "accepts the pushed family config, and an env change alone reaches a warm query and two warm Node actions that share the list",
    () =>
      Effect.gen(function* () {
        const backend = yield* LocalBackend.LocalBackend;
        const { platform, billing } = yield* mintPeers;
        const platformPeer = {
          name: "platform",
          issuer: platformIssuer,
          jwks: platform.jwks,
        };
        yield* setPeers(backend, [platformPeer]);
        const first = yield* peersEverywhere;
        expect(first).toEqual(everywhere(["platform"]));

        yield* setPeers(backend, [
          platformPeer,
          { name: "billing", issuer: billingIssuer, jwks: billing.jwks },
        ]);
        const added = yield* peersEverywhere;
        expect(added).toEqual(everywhere(["platform", "billing"]));

        // The renamed peer keeps its issuer, so only a list read after the
        // change can name it.
        yield* setPeers(backend, [{ ...platformPeer, name: "tenant" }]);
        const renamed = yield* peersEverywhere;
        expect(renamed).toEqual(everywhere(["tenant"]));
      }),
    { timeout: 120_000 },
  );

  it.effect(
    "authenticates each listed issuer as its peer, and refuses an issuer the value no longer lists",
    () =>
      Effect.gen(function* () {
        const backend = yield* LocalBackend.LocalBackend;
        const { platform, billing } = yield* mintPeers;
        const platformPeer = {
          name: "platform",
          issuer: platformIssuer,
          jwks: platform.jwks,
          applicationID: audience,
        };
        yield* setPeers(backend, [
          platformPeer,
          { name: "billing", issuer: billingIssuer, jwks: billing.jwks },
        ]);
        const both = ["platform", "billing"];
        const asPlatform = yield* call("query", "peers:read", platform.token);
        expect(asPlatform).toEqual(
          answered({ peers: both, caller: "platform" }),
        );
        const asBilling = yield* call("query", "peers:read", billing.token);
        expect(asBilling).toEqual(answered({ peers: both, caller: "billing" }));

        yield* setPeers(backend, [platformPeer]);
        const stillPlatform = yield* call(
          "query",
          "peers:read",
          platform.token,
        );
        expect(stillPlatform).toEqual(
          answered({ peers: ["platform"], caller: "platform" }),
        );
        const removed = yield* call("query", "peers:read", billing.token);
        expect(removed).toEqual(noProvider);
      }),
    { timeout: 120_000 },
  );

  it.effect(
    "refuses an invalid value or one that overlaps another provider, and the previous config keeps working",
    () =>
      Effect.gen(function* () {
        const backend = yield* LocalBackend.LocalBackend;
        const { platform, billing } = yield* mintPeers;
        const platformPeer = {
          name: "platform",
          issuer: platformIssuer,
          jwks: platform.jwks,
        };
        const billingPeer = {
          name: "billing",
          issuer: billingIssuer,
          jwks: billing.jwks,
        };
        yield* setPeers(backend, [platformPeer]);
        const refused: Readonly<
          Record<
            string,
            string | ReadonlyArray<Readonly<Record<string, string>>>
          >
        > = {
          "not JSON": "platform,billing",
          "an empty list": [],
          "a name listed twice": [
            platformPeer,
            { ...billingPeer, name: "platform" },
          ],
          "an issuer listed twice": [
            platformPeer,
            { ...billingPeer, issuer: `${platformIssuer}/` },
          ],
          "an unknown field": [{ ...platformPeer, applicationId: audience }],
          "the static provider's issuer": [
            platformPeer,
            { ...billingPeer, issuer: person.issuer },
          ],
        };
        for (const [name, value] of Rec.toEntries(refused)) {
          const error = yield* Effect.flip(
            typeof value === "string"
              ? backend.setEnv("PEER_SERVICES", value)
              : setPeers(backend, value),
          );
          expect(error._tag, name).toBe("BackendEnvironmentSetupError");
        }
        const asPlatform = yield* call("query", "peers:read", platform.token);
        expect(asPlatform).toEqual(
          answered({ peers: ["platform"], caller: "platform" }),
        );
        const asBilling = yield* call("query", "peers:read", billing.token);
        expect(asBilling).toEqual(noProvider);
        const kept = yield* peersEverywhere;
        expect(kept).toEqual(everywhere(["platform"]));
      }),
    { timeout: 120_000 },
  );
});
