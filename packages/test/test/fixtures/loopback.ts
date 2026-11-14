// oxlint-disable effecttsgo/new-promise -- The server's callbacks are Node's.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The egress cases count requests on a real loopback server.
import { createServer, type Server } from "node:http";
import * as Effect from "effect/Effect";

export interface Loopback {
  readonly url: string;
  /**
   * The host a fetch of `url` names.
   */
  readonly host: string;
  /**
   * How many requests reached the server.
   */
  readonly hits: () => number;
}

/**
 * A server on 127.0.0.1 that answers every request with its path, closed when
 * the scope ends.
 */
export const loopback = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly server: Server; readonly answering: Loopback }>(
        (resolve) => {
          let hits = 0;
          const server = createServer((request, response) => {
            hits += 1;
            response.end(`reached ${request.url}`);
          });
          server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };
            resolve({
              server,
              answering: {
                url: `http://127.0.0.1:${port}/ping`,
                host: `127.0.0.1:${port}`,
                hits: () => hits,
              },
            });
          });
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
).pipe(Effect.map(({ answering }) => answering));
