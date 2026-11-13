/**
 * The binary's answer to a route that throws, which the test kernel and the
 * mounted bridge copy (`packages/test/test/Http.test.ts`,
 * `test/mock-backend/httpRoute*.test.ts` and the mounted case in
 * `test/mock-backend/components.test.ts`).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { expectServerError } from "../mock-backend/serverError";
import * as LocalBackend from "./LocalBackend";

layer(
  Layer.mergeAll(
    LocalBackend.plainLayer,
    NodeServices.layer,
    FetchHttpClient.layer,
  ),
  { timeout: "120 seconds", excludeTestServices: true },
)("HTTP route errors on the binary", (it) => {
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
      expect(yield* response.text).toBe("No matching routes found");
    }),
  );
});
