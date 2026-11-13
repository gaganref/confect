// oxlint-disable effecttsgo/new-promise -- The loopback server's callbacks are Node's.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The case counts requests on a real loopback server.
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { recordOutcomes, type Outcome } from "./conformance";
import refs from "./fixtures/confect/_generated/refs";
import * as TestConfect from "./TestConfect";

// The binary performs this fetch, and so does convex-test, so the case is the
// convex-test lane's one conformance exception (`conformance.ts`).

const loopback = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly server: Server; readonly port: number }>(
        (resolve) => {
          const server = createServer((request, response) =>
            response.end(`reached ${request.url}`),
          );
          server.listen(0, "127.0.0.1", () =>
            resolve({
              server,
              port: (server.address() as { port: number }).port,
            }),
          );
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
);

describe("action egress", () => {
  it.effect(
    "a raw fetch in an action or a Node action dies with UndeclaredFetch naming the action and host",
    ({ task }) =>
      Effect.gen(function* () {
        const { port } = yield* loopback;
        const host = `127.0.0.1:${port}`;
        const url = `http://${host}/ping`;
        const c = yield* TestConfect.TestConfect;
        const calls = [
          ["groups/egress:rawFetch", refs.public.groups.egress.rawFetch],
          ["egressNode:rawFetchNode", refs.public.egressNode.rawFetchNode],
        ] as const;
        // On the binary, and on convex-test, each action returns the server's
        // response.
        const outcomes = yield* Effect.forEach(calls, ([name, ref]) =>
          Effect.exit(c.action(ref, { url })).pipe(
            Effect.map((exit): Outcome => {
              if (Exit.isSuccess(exit)) {
                return { function: name, returned: exit.value };
              }
              const error = Cause.squash(exit.cause) as {
                readonly _tag?: string;
                readonly name?: string;
                readonly message?: string;
              };
              return {
                function: name,
                failed: {
                  tag: error._tag ?? error.name ?? "unknown",
                  message: error.message ?? "",
                },
              };
            }),
          ),
        );
        recordOutcomes(task, outcomes);
        expect(outcomes).toEqual(
          calls.map(([name]) => ({
            function: name,
            failed: {
              tag: "BackendRefusal",
              message: expect.stringContaining(
                `The action ${name} fetched ${host} directly.`,
              ),
            },
          })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestConfect.layer)),
  );
});
