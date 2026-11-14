// oxlint-disable-next-line effecttsgo/node-builtin-import -- The case counts requests on a real loopback server.
import { createServer, type Server } from "node:http";
import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import refs from "confect-local-backend/refs";
import * as LocalBackend from "confect-local-backend/LocalBackend";

// The binary performs a raw fetch in an action and in a Node action. The test
// kernel refuses both with `UndeclaredFetch`, its one deliberate departure,
// and this case is the evidence the convex-test lane's exception names
// (`test/mock-backend/conformance.ts`).

const loopback = Effect.acquireRelease(
  Effect.promise(
    () =>
      // oxlint-disable-next-line effecttsgo/new-promise -- Node's http server reports listening and closing through callbacks.
      new Promise<{ readonly server: Server; readonly hits: () => number }>(
        (resolve) => {
          let hits = 0;
          const server = createServer((request, response) => {
            hits += 1;
            response.end(`reached ${request.url}`);
          });
          server.listen(0, "127.0.0.1", () =>
            resolve({ server, hits: () => hits }),
          );
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(
      // oxlint-disable-next-line effecttsgo/new-promise -- Node's http server reports listening and closing through callbacks.
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
);

layer(LocalBackend.layer, { timeout: "120 seconds" })("action egress", (it) => {
  it.effect("an action and a Node action perform a raw fetch", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const { server, hits } = yield* loopback;
      const { port } = server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/ping`;
      const observed = yield* Ref.runWithCodec(
        refs.public.groups.ioBans.fetchInAction,
        { url },
        (ref, args) => client.action(ref, args),
      );
      expect(observed).toBe("reached /ping");
      const observed2 = yield* Ref.runWithCodec(
        refs.public.egressNode.rawFetchNode,
        { url },
        (ref, args) => client.action(ref, args),
      );
      expect(observed2).toBe("reached /ping");
      expect(hits()).toBe(2);
    }).pipe(Effect.scoped),
  );
});
