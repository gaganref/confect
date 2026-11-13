import { expect, layer } from "@effect/vitest";
import { makeFunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as LocalBackend from "confect-local-backend/LocalBackend";

layer(Layer.merge(LocalBackend.consumerLayer, FetchHttpClient.layer), {
  timeout: "120 seconds",
  excludeTestServices: true,
})("declared consumer on a real backend", (it) => {
  it.effect("mounts HTTP, invokes a callback, and reads declared env", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const response = yield* HttpClient.get(
        LocalBackend.siteUrl("/counter/health", LocalBackend.ports.consumer),
      );
      expect(response.status).toBe(200);
      const text2 = yield* response.text;
      expect(text2).toBe("component ready");
      const resolved = yield* Effect.promise(() =>
        client.mutation(
          makeFunctionReference<"mutation", { value: number }, number>(
            "hello:notify",
          ),
          { value: 21 },
        ),
      );
      expect(resolved).toBe(43);
      const resolved2 = yield* Effect.promise(() =>
        client.query(
          makeFunctionReference<"query", {}, string>("hello:readMarker"),
        ),
      );
      expect(resolved2).toBe("declared-consumer");
    }),
  );
});
