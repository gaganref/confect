/**
 * The binary's own HTTP answers, which the test kernel and the mounted bridge
 * copy (`packages/test/test/Http.test.ts`,
 * `test/mock-backend/httpRoute*.test.ts` and the mounted case in
 * `test/mock-backend/components.test.ts`): a route that throws, a missing
 * route, HEAD and OPTIONS requests and duplicate headers. The wire cases send
 * raw requests, so two values of one header stay two.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The wire cases read raw header lines, which no fetch API keeps apart.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { convexTest } from "../../../test/src/internal/ConvexTest";
import { expectServerError } from "../mock-backend/serverError";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import * as Arr from "effect/Array";
import * as String from "effect/String";
import { pipe } from "effect/Function";

/**
 * One raw request to the plain probe: its status, raw header lines and body.
 */
const raw = (
  method: string,
  path: string,
  options: {
    readonly headers?: Record<string, string | ReadonlyArray<string>>;
    readonly body?: string;
  } = {},
) =>
  Effect.callback<{
    status: number;
    rawHeaders: ReadonlyArray<string>;
    body: string;
  }>((resume) => {
    const request = NodeHttp.request(
      LocalBackend.siteUrl(path, LocalBackend.ports.plain),
      {
        method,
        headers: options.headers as NodeHttp.OutgoingHttpHeaders,
        // A connection of its own, so a body the backend leaves unread never
        // reaches the next request.
        agent: false,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              rawHeaders: response.rawHeaders,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    request.on("error", (error) => resume(Effect.die(error)));
    request.end(options.body);
  });

/**
 * The values a raw response sent under `name`, one per header line.
 */
const lines = (rawHeaders: ReadonlyArray<string>, name: string) =>
  Arr.flatMap(rawHeaders, (value, i) =>
    i % 2 === 0 && pipe(value, String.toLowerCase) === name
      ? [rawHeaders[i + 1]!]
      : [],
  );

/**
 * The same plain router on the test kernel.
 */
const kernel = () =>
  convexTest(undefined, {
    "_generated/server.ts": () => Promise.resolve({}),
    "http.ts": () =>
      import("../../../../tools/local-backend/fixtures/plain/convex/http"),
  }) as {
    readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  };

layer(
  Layer.mergeAll(
    LocalBackend.plainLayer,
    NodeServices.layer,
    FetchHttpClient.layer,
  ),
  { timeout: "120 seconds", excludeTestServices: true },
)("HTTP route errors and ingress on the binary", (it) => {
  it.effect.each([
    {
      name: "an Error",
      path: "/throws",
      uncaught: "Uncaught Error: The route failed.",
      data: undefined,
    },
    {
      name: "a ConvexError",
      path: "/throws-convex-error",
      uncaught: 'Uncaught ConvexError: {"code":"denied","attempt":2}',
      data: { attempt: 2, code: "denied" },
    },
  ])(
    "a route that throws $name answers 500 with the redacted-error JSON body",
    ({ path, uncaught, data }) =>
      Effect.gen(function* () {
        yield* LocalBackend.LocalBackend;
        const response = yield* HttpClient.get(
          LocalBackend.siteUrl(path, LocalBackend.ports.plain),
        );
        const body = yield* response.text;
        yield* expectServerError(
          new Response(body, {
            status: response.status,
            headers: response.headers,
          }),
          uncaught,
          data,
        );
      }),
  );

  it.effect("a path no route has answers 404 No matching routes found", () =>
    Effect.gen(function* () {
      yield* LocalBackend.LocalBackend;
      const response = yield* HttpClient.get(
        LocalBackend.siteUrl("/nope", LocalBackend.ports.plain),
      );
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toBe(
        "text/plain; charset=utf-8",
      );
      const text2 = yield* response.text;
      expect(text2).toBe("No matching routes found");
    }),
  );

  it.effect.each([
    { path: "/ok", status: 200 },
    { path: "/nope", status: 404 },
    { path: "/throws", status: 500 },
  ])(
    "a HEAD request to $path answers $status with no body, as the test kernel does",
    ({ path, status }) =>
      Effect.gen(function* () {
        yield* LocalBackend.LocalBackend;
        const binary = yield* raw("HEAD", path);
        expect([binary.status, binary.body]).toEqual([status, ""]);
        const response = yield* Effect.promise(() =>
          kernel().fetch(path, { method: "HEAD" }),
        );
        expect([
          response.status,
          yield* Effect.promise(() => response.text()),
        ]).toEqual([status, ""]);
        expect(response.headers.get("content-type")).toBe(
          lines(binary.rawHeaders, "content-type")[0],
        );
      }),
  );

  it.effect(
    "an OPTIONS request's body never reaches its route, as on the test kernel",
    () =>
      Effect.gen(function* () {
        yield* LocalBackend.LocalBackend;
        const binary = yield* raw("OPTIONS", "/echo", {
          headers: { "content-type": "text/plain" },
          body: "discarded",
        });
        expect(binary.body).toBe("received 0");
        const response = yield* Effect.promise(() =>
          kernel().fetch("/echo", { method: "OPTIONS", body: "discarded" }),
        );
        const resolved = yield* Effect.promise(() => response.text());
        expect(resolved).toBe(binary.body);
      }),
  );

  it.effect(
    "two values of one header reach a route joined, and a route's two set-cookie and two values of one header leave as the test kernel keeps them",
    () =>
      Effect.gen(function* () {
        yield* LocalBackend.LocalBackend;
        const binary = yield* raw("GET", "/headers", {
          headers: { "x-dup": ["a", "b"] },
        });
        expect(binary.body).toBe("a, b");
        expect(lines(binary.rawHeaders, "set-cookie")).toEqual([
          "a=1; Path=/",
          "b=2; Path=/",
        ]);
        const multi = lines(binary.rawHeaders, "x-multi");
        expect(Arr.join(multi, ", ")).toBe("first, second");

        const response = yield* Effect.promise(() =>
          kernel().fetch("/headers", {
            headers: [
              ["x-dup", "a"],
              ["x-dup", "b"],
            ],
          }),
        );
        const resolved = yield* Effect.promise(() => response.text());
        expect(resolved).toBe(binary.body);
        expect(response.headers.getSetCookie()).toEqual(
          lines(binary.rawHeaders, "set-cookie"),
        );
        expect(response.headers.get("x-multi")).toBe(Arr.join(multi, ", "));
      }),
  );
});
