import { expect, layer } from "@effect/vitest";
import { makeFunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as LocalBackend from "./LocalBackend";

layer(Layer.merge(LocalBackend.consumerLayer, FetchHttpClient.layer), {
  timeout: "120 seconds",
  excludeTestServices: true,
})("declared consumer on a real backend", (it) => {
  it.effect("mounts HTTP, invokes a callback, and reads declared env", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const response = yield* HttpClient.get(
        "http://127.0.0.1:3221/counter/health",
      );
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("component ready");
      expect(
        yield* Effect.promise(() =>
          client.mutation(
            makeFunctionReference<"mutation", { value: number }, number>(
              "hello:notify",
            ),
            { value: 21 },
          ),
        ),
      ).toBe(43);
      expect(
        yield* Effect.promise(() =>
          client.query(
            makeFunctionReference<"query", {}, string>("hello:readMarker"),
          ),
        ),
      ).toBe("declared-consumer");
    }),
  );
});
