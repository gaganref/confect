import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  expected,
  normalize,
} from "../../../test/test/fixtures/randomnessProbe";
import refs from "confect-local-backend/refs";
import * as LocalBackend from "confect-local-backend/LocalBackend";

const probe = refs.public.groups.randomness;

layer(LocalBackend.layer, { timeout: "120 seconds" })(
  "randomness on a real backend",
  (it) => {
    it.effect(
      "a query, a mutation and an action may each draw from Math.random and crypto, and refuse the fills the binary refuses",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          expect({
            query: normalize(
              yield* Ref.runWithCodec(probe.query, {}, (ref, args) =>
                client.query(ref, args),
              ),
            ),
            mutation: normalize(
              yield* Ref.runWithCodec(probe.mutation, {}, (ref, args) =>
                client.mutation(ref, args),
              ),
            ),
            action: normalize(
              yield* Ref.runWithCodec(probe.action, {}, (ref, args) =>
                client.action(ref, args),
              ),
            ),
          }).toEqual(expected);
        }),
    );
  },
);
