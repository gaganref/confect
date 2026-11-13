import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { mint, type VerifierOutcome } from "../../../test/test/fixtures/minted";
import * as LocalBackend from "./LocalBackend";

const Answer = Schema.Struct({
  status: Schema.Literal("success"),
  value: Schema.TaggedStruct("Valid", { identity: Schema.Unknown }),
});

const Refusal = Schema.Struct({
  code: Schema.Literals(["NoAuthProvider", "InvalidAuthHeader"]),
});

layer(
  Layer.mergeAll(LocalBackend.layer, NodeServices.layer, FetchHttpClient.layer),
  { timeout: "120 seconds", excludeTestServices: true },
)("JWT verification on a real backend", (it) => {
  it.effect(
    "accepts the valid control and refuses a wrong issuer, a wrong audience, a foreign key and an expired token",
    () =>
      Effect.gen(function* () {
        const backend = yield* LocalBackend.LocalBackend;
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const { jwks, cases } = yield* mint(now);
        yield* backend.setEnv("TEST_AUTH_JWKS", jwks);
        yield* backend.redeploy;
        // A client's query request, as `ConvexHttpClient` sends it, so the
        // status of a refusal is visible.
        const ask = (token: string) =>
          HttpClientRequest.post(`${LocalBackend.cloudUrl()}/api/query`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyJsonUnsafe({
              path: "groups/components:identity",
              format: "convex_encoded_json",
              args: [{}],
            }),
            HttpClient.execute,
          );
        for (const { name, token, expected } of cases) {
          const response = yield* ask(token);
          const body = yield* response.json;
          const outcome: VerifierOutcome =
            response.status === 401
              ? {
                  _tag: "refused",
                  refusal: "InvalidToken",
                  code: (yield* Schema.decodeUnknownEffect(Refusal)(body)).code,
                }
              : {
                  _tag: "accepted",
                  identity: (yield* Schema.decodeUnknownEffect(Answer)(body))
                    .value.identity as object,
                };
          expect(outcome, name).toEqual(expected);
        }
      }),
  );
});
