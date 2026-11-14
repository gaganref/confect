import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  expected,
  normalize,
} from "../../../test/test/fixtures/randomnessProbe";
import refs from "confect-local-backend/refs";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import { refusalBoundary } from "../mock-backend/kernelBoundaries";

const probe = refs.public.groups.randomness;

layer(LocalBackend.layer, { timeout: "120 seconds" })(
  "randomness on a real backend",
  (it) => {
    it.effect(
      "a query, a mutation and an action may each draw from Math.random and crypto, refuse the fills the binary refuses, and generate a key only in an action",
      () =>
        Effect.gen(function* () {
          // The binary answers an action's key generation, at run time and at
          // load, where the kernel refuses; these entries record why.
          const entries = [
            refusalBoundary("ActionCryptoRandomness"),
            refusalBoundary("ActionLoadCryptoRandomness"),
          ];
          expect(entries).toHaveLength(2);
          const { client } = yield* LocalBackend.LocalBackend;
          const query = yield* Ref.runWithCodec(probe.query, {}, (ref, args) =>
            client.query(ref, args),
          );
          const mutation = yield* Ref.runWithCodec(
            probe.mutation,
            {},
            (ref, args) => client.mutation(ref, args),
          );
          const action = yield* Ref.runWithCodec(
            probe.action,
            {},
            (ref, args) => client.action(ref, args),
          );
          expect({
            query: normalize(query),
            mutation: normalize(mutation),
            action: normalize(action),
          }).toEqual(expected);
        }),
    );
  },
);
