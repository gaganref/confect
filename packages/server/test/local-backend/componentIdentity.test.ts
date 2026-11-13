import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  expected,
  subject,
} from "../../../test/test/fixtures/componentIdentityProbe";
import { mintToken, send } from "./clientCall";
import refs from "confect-local-backend/refs";
import * as LocalBackend from "confect-local-backend/LocalBackend";

const probe = refs.public.groups.componentIdentity;

layer(LocalBackend.layer, {
  timeout: "120 seconds",
  excludeTestServices: true,
})("component identity on a real backend", (it) => {
  it.effect(
    "a component and every mount nested under it read the caller's identity when a query or a mutation calls in, and none when an action does",
    () =>
      Effect.gen(function* () {
        const headers = {
          authorization: `Bearer ${yield* mintToken(subject)}`,
        };
        expect({
          query: yield* Ref.runWithCodec(
            probe.fromQuery,
            {},
            send("query", headers),
          ),
          mutation: yield* Ref.runWithCodec(
            probe.fromMutation,
            {},
            send("mutation", headers),
          ),
          action: yield* Ref.runWithCodec(
            probe.fromAction,
            {},
            send("action", headers),
          ),
        }).toEqual(expected);
      }),
  );
});
