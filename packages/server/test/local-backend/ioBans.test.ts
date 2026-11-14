// oxlint-disable-next-line effecttsgo/node-builtin-import -- The action control fetches from a real loopback server.
import { createServer, type Server } from "node:http";
import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { makeFunctionReference } from "convex/server";
import refs from "confect-local-backend/refs";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import { refusalBoundary } from "../mock-backend/kernelBoundaries";

// The same calls as `packages/test/test/IoBans.test.ts`, answered by the
// binary. The test kernel's I/O bans follow what these cases record.

const url = "https://api.example.com/v1/charges?token=secret";

const timerRefusal = (name: string) =>
  `Can't use ${name} in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.`;

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.map((value) => ({ returned: value }) as const),
    Effect.catchCause((cause) =>
      Effect.succeed({ failed: Cause.pretty(cause) }),
    ),
  );

const loopback = Effect.acquireRelease(
  Effect.promise(
    () =>
      // oxlint-disable-next-line effecttsgo/new-promise -- Node's http server reports listening and closing through callbacks.
      new Promise<{ readonly server: Server; url: string; hits: number }>(
        (resolve) => {
          const state = {
            server: undefined as unknown as Server,
            url: "",
            hits: 0,
          };
          state.server = createServer((request, response) => {
            state.hits += 1;
            response.end(`reached ${request.url}`);
          }).listen(0, "127.0.0.1", () => {
            const address = state.server.address() as { port: number };
            state.url = `http://127.0.0.1:${address.port}/ping`;
            resolve(state);
          });
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(
      // oxlint-disable-next-line effecttsgo/new-promise -- Node's http server reports listening and closing through callbacks.
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
);

layer(LocalBackend.layer, { timeout: "120 seconds" })("I/O bans", (it) => {
  it.effect(
    "a query's and a mutation's fetch reject with the binary's TypeError",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const refusal = {
          name: "TypeError",
          message:
            "fetch to https://api.example.com/v1/charges failed: Can't use fetch() in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.",
        };
        const observed = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.fetchInQuery,
          { url },
          (ref, args) => client.query(ref, args),
        );
        expect(observed).toEqual(refusal);
        const observed2 = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.fetchInMutation,
          { url },
          (ref, args) => client.mutation(ref, args),
        );
        expect(observed2).toEqual(refusal);
      }),
  );

  it.effect(
    "a query or mutation that starts a host timer fails after it returns",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        for (const name of ["setTimeout", "setInterval"] as const) {
          const query = yield* failureOf(
            Ref.runWithCodec(
              refs.public.groups.ioBans.timerInQuery,
              { name },
              (ref, args) => client.query(ref, args),
            ),
          );
          const mutation = yield* failureOf(
            Ref.runWithCodec(
              refs.public.groups.ioBans.timerInMutation,
              { name },
              (ref, args) => client.mutation(ref, args),
            ),
          );
          for (const outcome of [query, mutation]) {
            expect(outcome).toHaveProperty("failed");
            expect((outcome as { failed: string }).failed).toContain(
              timerRefusal(name),
            );
          }
        }
      }),
  );

  it.effect(
    "a query or mutation that awaits a host timer fails without waiting on it",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        for (const name of ["setTimeout", "setInterval"] as const) {
          const query = yield* failureOf(
            Ref.runWithCodec(
              refs.public.groups.ioBans.awaitedTimerInQuery,
              { name },
              (ref, args) => client.query(ref, args),
            ),
          );
          const mutation = yield* failureOf(
            Ref.runWithCodec(
              refs.public.groups.ioBans.awaitedTimerInMutation,
              { name },
              (ref, args) => client.mutation(ref, args),
            ),
          );
          for (const outcome of [query, mutation]) {
            expect(outcome).toHaveProperty("failed");
            expect((outcome as { failed: string }).failed).toContain(
              timerRefusal(name),
            );
          }
        }
      }),
  );

  it.effect(
    "a query and an isolate action define no setImmediate and no queueMicrotask, and a Node action has both",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const absent = {
          setImmediate: "undefined",
          queueMicrotask: "undefined",
        };
        const observed = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.surfaceInQuery,
          {},
          (ref, args) => client.query(ref, args),
        );
        expect(observed).toEqual(absent);
        const observed2 = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.surfaceInAction,
          {},
          (ref, args) => client.action(ref, args),
        );
        expect(observed2).toEqual(absent);
        const observed3 = yield* Ref.runWithCodec(
          refs.public.ioBansNode.surfaceNode,
          {},
          (ref, args) => client.action(ref, args),
        );
        expect(observed3).toEqual({
          setImmediate: "function",
          queueMicrotask: "function",
        });
      }),
  );

  it.effect("a query may clear a timer", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const observed = yield* Ref.runWithCodec(
        refs.public.groups.ioBans.clearInQuery,
        {},
        (ref, args) => client.query(ref, args),
      );
      expect(observed).toBe("cleared");
    }),
  );

  it.effect(
    "a query's and a mutation's multipart formData() are refused, while urlencoded and an action's parse",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const refusal = {
          name: "Error",
          message:
            "Can't use formData() in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.",
        };
        const observed = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.formDataInQuery,
          { body: "multipart" },
          (ref, args) => client.query(ref, args),
        );
        expect(observed).toEqual(refusal);
        const observed2 = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.formDataInMutation,
          { body: "multipart" },
          (ref, args) => client.mutation(ref, args),
        );
        expect(observed2).toEqual(refusal);
        const observed3 = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.formDataInQuery,
          { body: "urlencoded" },
          (ref, args) => client.query(ref, args),
        );
        expect(observed3).toEqual({ returned: "ada" });
        const observed4 = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.formDataInQuery,
          { body: "multipartWithoutBoundary" },
          (ref, args) => client.query(ref, args),
        );
        expect(observed4).toEqual({
          name: "TypeError",
          message:
            "Missing boundary parameter in mime type of multipart formdata.",
        });
        const observed5 = yield* Ref.runWithCodec(
          refs.public.groups.ioBans.formDataInAction,
          { body: "multipart" },
          (ref, args) => client.action(ref, args),
        );
        expect(observed5).toEqual({ returned: "ada" });
      }),
  );

  it.effect("an action performs a raw fetch and runs host timers", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const server = yield* loopback;
      const observed = yield* Ref.runWithCodec(
        refs.public.groups.ioBans.fetchInAction,
        { url: server.url },
        (ref, args) => client.action(ref, args),
      );
      expect(observed).toBe("reached /ping");
      expect(server.hits).toBe(1);
      const observed2 = yield* Ref.runWithCodec(
        refs.public.groups.ioBans.timersInAction,
        {},
        (ref, args) => client.action(ref, args),
      );
      expect(observed2).toEqual(["slept", "ticked"]);
    }).pipe(Effect.scoped),
  );
});

layer(LocalBackend.plainLayer, { timeout: "120 seconds" })(
  "I/O bans while a module loads",
  (it) => {
    it.effect(
      "an isolate module's top-level fetch is refused for a query and answered for an action, where the kernel refuses both",
      () =>
        Effect.gen(function* () {
          // The binary answers the module's fetch, where the kernel refuses
          // it; this entry records why.
          const entry = refusalBoundary("ActionModuleLoadFetch");
          expect(entry.probe).toBe(
            "ioBans.test.ts > I/O bans while a module loads > an isolate module's top-level fetch is refused for a query and answered for an action, where the kernel refuses both",
          );
          const { client } = yield* LocalBackend.LocalBackend;
          const observed = yield* Effect.promise(() =>
            client.action(
              makeFunctionReference<"action">("moduleLoadFetch:loaded"),
              {},
            ),
          );
          expect(observed).toEqual({ status: 200, body: "ok" });
          // A query's load is refused, as the kernel refuses every load.
          const observed2 = yield* Effect.promise(() =>
            client.query(
              makeFunctionReference<"query">("moduleLoadFetch:loadedQuery"),
              {},
            ),
          );
          expect(observed2).toMatchObject({ name: "TypeError" });
          expect((observed2 as { message: string }).message).toMatch(
            /^fetch to http:\/\/127\.0\.0\.1:\d+\/ok failed: Can't use fetch\(\) in queries and mutations\./,
          );
        }),
    );

    it.effect(
      'a "use node" module\'s top-level fetch is answered, where the kernel refuses it with UndeclaredFetch',
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const observed = yield* Effect.promise(() =>
            client.action(
              makeFunctionReference<"action">("moduleLoadFetchNode:loaded"),
              {},
            ),
          );
          expect(observed).toEqual({ status: 200, body: "ok" });
        }),
    );
  },
);
