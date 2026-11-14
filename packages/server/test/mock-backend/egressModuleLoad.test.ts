// oxlint-disable-next-line effecttsgo/node-builtin-import -- The case counts requests on a real loopback server.
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { departs, recordOutcomes, type Outcome } from "./conformance";
import refs from "./fixtures/confect/_generated/refs";
import * as TestConfect from "./TestConfect";

// A "use node" module whose top level fetches while it loads. The binary's
// Node executor performs the fetch, and so does convex-test, so the case is a
// convex-test lane conformance exception (`conformance.ts`), part of the action
// egress departure. It has a file of its own so the module loads afresh in it:
// a module the host already evaluated is not evaluated again.

const warmUp = Symbol.for("@confect/server/test/egressWarmUp");

const loopback = Effect.acquireRelease(
  Effect.promise(
    () =>
      // oxlint-disable-next-line effecttsgo/new-promise -- Node's http server reports listening and closing through callbacks.
      new Promise<{
        readonly server: Server;
        readonly port: number;
        readonly hits: () => number;
      }>((resolve) => {
        let hits = 0;
        const server = createServer((request, response) => {
          hits += 1;
          response.end(`reached ${request.url}`);
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({
            server,
            port: (server.address() as { port: number }).port,
            hits: () => hits,
          }),
        );
      }),
  ),
  ({ server }) =>
    Effect.promise(
      // oxlint-disable-next-line effecttsgo/new-promise -- Node's http server reports listening and closing through callbacks.
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
);

describe("action egress while a module loads", () => {
  it.effect(
    'a "use node" module\'s top-level fetch dies with UndeclaredFetch naming the module and host',
    ({ task }) =>
      Effect.gen(function* () {
        const { port, hits } = yield* loopback;
        const host = `127.0.0.1:${port}`;
        const url = `http://${host}/ping`;
        yield* Effect.acquireRelease(
          Effect.sync(() => Reflect.set(globalThis, warmUp, `${url}?load`)),
          () => Effect.sync(() => Reflect.deleteProperty(globalThis, warmUp)),
        );
        const services = yield* Layer.build(TestConfect.layer);
        return yield* Effect.gen(function* () {
          const c = yield* TestConfect.TestConfect;
          const name = "egressNode:rawFetchNode";
          const exit = yield* Effect.exit(
            c.action(refs.public.egressNode.rawFetchNode, { url }),
          );
          const error = Exit.isSuccess(exit)
            ? undefined
            : (Cause.squash(exit.cause) as {
                readonly _tag?: string;
                readonly name?: string;
                readonly message?: string;
              });
          const outcome: Outcome =
            error === undefined
              ? { function: name, returned: Exit.isSuccess(exit) && exit.value }
              : {
                  function: name,
                  failed: {
                    tag: error._tag ?? error.name ?? "unknown",
                    message: error.message ?? "",
                  },
                };
          recordOutcomes(task, [outcome]);
          // The departure: on convex-test, as on the binary, the module's load
          // and then the action each reach the server, and the action returns
          // its response.
          departs(task, () =>
            expect({ outcome, hits: hits() }).toEqual({
              outcome: {
                function: name,
                failed: {
                  tag: "BackendRefusal",
                  message: expect.stringContaining(
                    `The module egressNode fetched ${host} directly while it loaded.`,
                  ),
                },
              },
              hits: 0,
            }),
          );
        }).pipe(Effect.provideContext(services));
      }).pipe(Effect.scoped),
  );
});
