import { expect, layer } from "@effect/vitest";
import { ConvexClient } from "convex/browser";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Random from "effect/Random";
import * as Deferred from "effect/Deferred";
import { api } from "../../../../tools/local-backend/fixtures/convex/_generated/api";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";

layer(LocalBackend.layer, {
  timeout: "120 seconds",
  excludeTestServices: true,
})("Component pagination", (it) => {
  it.effect(
    "pages a component through its host to the end without gaps or repeats",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const random = yield* Random.next;
        const run = String(random);
        yield* Effect.promise(() =>
          client.mutation(api.groups.components.seed, {
            run,
            counts: [1, 2, 3, 4, 5],
          }),
        );
        const rows: number[] = [];
        let cursor: string | null = null;
        let done = false;
        while (!done) {
          const page = yield* Effect.promise(() =>
            client.query(api.groups.pagination.page, {
              run,
              cursor,
              numItems: 2,
            }),
          );
          rows.push(...page.page);
          cursor = page.continueCursor;
          done = page.isDone;
        }
        expect(rows).toEqual([1, 2, 3, 4, 5]);
      }),
  );
  it.effect("pages search results inside a component", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const random = yield* Random.next;
      const run = `search${pipe(String(random), Str.replaceAll(".", ""))}`;
      yield* Effect.promise(() =>
        client.mutation(api.groups.components.seed, {
          run,
          counts: [1, 2, 3, 4, 5],
        }),
      );
      const page = yield* Effect.promise(() =>
        client.query(api.groups.pagination.searchPage, {
          run,
          cursor: null,
          numItems: 2,
        }),
      );
      expect(page.page).toHaveLength(2);
      expect(
        Arr.every(page.page, (count) => [1, 2, 3, 4, 5].includes(count)),
      ).toBe(true);
      expect(page.isDone).toBe(false);
      expect(page.continueCursor).not.toBe("");
    }),
  );
  it.effect("updates a subscribed component page after an insert", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const random = yield* Random.next;
      const run = String(random);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactive = yield* Effect.acquireRelease(
            Effect.sync(() => new ConvexClient("http://127.0.0.1:3210")),
            (reactiveClient) => Effect.promise(() => reactiveClient.close()),
          );
          const initial = yield* Deferred.make<ReadonlyArray<number>>();
          const updated = yield* Deferred.make<ReadonlyArray<number>>();
          const context2 = yield* Effect.context<never>();
          const complete = Effect.runSyncWith(context2);
          let first = true;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              reactive.onUpdate(
                api.groups.pagination.page,
                { run, cursor: null, numItems: 10 },
                (page) => {
                  complete(
                    Deferred.succeed(first ? initial : updated, page.page),
                  );
                  first = false;
                },
                (error) => {
                  complete(Deferred.done(initial, Exit.die(error)));
                  complete(Deferred.done(updated, Exit.die(error)));
                },
              ),
            ),
            (stop) => Effect.sync(stop),
          );
          const awaitValue = yield* Deferred.await(initial);
          expect(awaitValue).toEqual([]);
          yield* Effect.promise(() =>
            client.mutation(api.groups.components.seed, { run, counts: [7] }),
          );
          const awaitValue2 = yield* Deferred.await(updated);
          expect(awaitValue2).toEqual([7]);
        }).pipe(Effect.timeout("10 seconds")),
      );
    }),
  );
  it.effect("refuses a second native page across the host and component", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      yield* Effect.promise(() =>
        expect(
          client.query(api.groups.pagination.twice, {
            run: "twice",
            cursor: null,
            numItems: 1,
          }),
        ).rejects.toThrow(
          /multiple.*paginated|only.*paginated|paginate.*once/i,
        ),
      );
    }),
  );
  it.effect(
    "defers and collects component streams, deduplicates merges and enforces the default budget",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const random = yield* Random.next;
        const run = String(random);
        const counts = Array.from({ length: 50 }, (_, i) => i + 100);
        for (let offset = 0; offset < counts.length; offset += 10) {
          yield* Effect.promise(() =>
            client.mutation(api.groups.components.seed, {
              run,
              counts: counts.slice(offset, offset + 10),
            }),
          );
        }
        const resolved = yield* Effect.promise(() =>
          client.query(api.groups.pagination.streams, { run }),
        );
        expect(resolved).toEqual({
          deferred: counts,
          merged: counts,
          budget: 2001,
        });
      }),
  );
  it.effect("observes decoded component writes through the writer hook", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const resolved = yield* Effect.promise(() =>
        client.mutation(api.groups.pagination.hook, { run: "hook" }),
      );
      expect(resolved).toEqual([
        { operation: "insert", count: 1 },
        { operation: "update", count: 2 },
        { operation: "delete", count: 2 },
      ]);
    }),
  );
});
