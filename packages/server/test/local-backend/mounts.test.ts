import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import refs from "confect-local-backend/refs";
import * as LocalBackend from "confect-local-backend/LocalBackend";

const mounts = refs.public.groups.mounts;

layer(LocalBackend.layer, { timeout: "120 seconds" })(
  "a mount's client on a real backend",
  (it) => {
    it.effect(
      "reaches its own installation with only the runner the handler has",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const run = String(yield* Random.next);
          const create = (mount: "first" | "second", count: number) =>
            Ref.runWithCodec(mounts.create, { mount, run, count }, (r, a) =>
              client.mutation(r, a),
            );
          yield* create("first", 1);
          yield* create("second", 2);
          const counts = (mount: "first" | "second") =>
            Ref.runWithCodec(mounts.counts, { mount, run }, (r, a) =>
              client.query(r, a),
            );
          expect(yield* counts("first")).toEqual([1]);
          expect(yield* counts("second")).toEqual([2]);
        }),
    );

    it.effect("is replaced inside provideService and nowhere else", () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        yield* Ref.runWithCodec(
          mounts.create,
          { mount: "first", run, count: 3 },
          (r, a) => client.mutation(r, a),
        );
        const replaced = yield* Ref.runWithCodec(
          mounts.replaced,
          { run },
          (r, a) => client.query(r, a),
        );
        expect(replaced).toEqual({ inside: [-1], outside: [3] });
      }),
    );
  },
);
