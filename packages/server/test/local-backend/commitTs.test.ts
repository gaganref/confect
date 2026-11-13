import type { CommitTs } from "@confect/core/CommitTs";
import { getFunctionReference } from "@confect/core/RefInternal";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import refs from "confect-local-backend/refs";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import * as Array from "effect/Array";

const functions = refs.public.groups.commitTs;

layer(LocalBackend.layer, { timeout: "120 seconds" })(
  "commit timestamps",
  (it) => {
    it.effect(
      "a mutation reads back the placeholder it wrote, not a number",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          expect(
            yield* Effect.promise(() =>
              client.mutation(getFunctionReference(functions.stamp), {
                caseId: "read-back",
                label: "only",
              }),
            ),
          ).toBe("placeholder");
        }),
    );

    it.effect(
      "later reads see a bigint, and an index on it orders by commit",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const caseId = `commit-order-${yield* Random.next}`;
          for (const label of ["first", "second", "third"]) {
            yield* Effect.promise(() =>
              client.mutation(getFunctionReference(functions.stamp), {
                caseId,
                label,
              }),
            );
          }

          const stamps: ReadonlyArray<{
            readonly label: string;
            readonly at: CommitTs;
          }> = yield* Effect.promise(() =>
            client.query(getFunctionReference(functions.newestFirst), {
              caseId,
            }),
          );

          expect(Array.map(stamps, ({ label }) => label)).toEqual([
            "third",
            "second",
            "first",
          ]);
          const [third, second, first] = Array.flatMap(stamps, ({ at }) =>
            typeof at === "bigint" ? [at] : [],
          );
          expect(first! < second! && second! < third!).toBe(true);
        }),
    );
  },
);
