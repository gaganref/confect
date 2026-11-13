import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  expected,
  subject,
} from "../../../test/test/fixtures/componentIdentityProbe";
import { mintToken, send } from "./clientCall";
import refs from "./fixtures/confect/_generated/refs";
import * as LocalBackend from "./LocalBackend";

const probe = refs.public.groups.componentIdentity;

layer(LocalBackend.layer, {
  timeout: "120 seconds",
  excludeTestServices: true,
})("component identity on a real backend", (it) => {
  it.effect(
    "a component and every mount nested under it read no identity, whether a query, a mutation or an action calls in",
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
