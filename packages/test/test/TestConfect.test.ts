import { TestConfect } from "@confect/test";
import { beforeEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import { App } from "@confect/core";
import counter from "../../server/test/local-backend/fixtures/components/counter/convex/convex.config";
import env from "../../server/test/local-backend/fixtures/confect/env";
import registry from "../../server/test/local-backend/fixtures/confect/_generated/testing";
import refs from "../../server/test/local-backend/fixtures/confect/_generated/refs";

beforeEach(() => vi.resetModules());

const app = App.make({
  env,
  mounts: {
    first: App.mount(counter, {
      httpPrefix: "/test-counter",
      env: { COMPONENT_REQUIRED: "fixture" },
    }),
  },
});

it.effect(
  "registers declared authored components for callbacks and mounted HTTP",
  () =>
    Effect.gen(function* () {
      const test = yield* TestConfect.TestConfect<typeof registry.schema>();
      const callbacks = refs.public.groups.callbacks;
      const id = yield* test.mutation(callbacks.send, { run: "declared-app" });
      yield* test.mutation(callbacks.setStatus, { id, status: "delivered" });
      expect(
        yield* test.query(callbacks.events, { run: "declared-app" }),
      ).toEqual(["delivered"]);
      const response = yield* test.fetch("/first/members/42");
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toBe("42");
    }).pipe(Effect.provide(TestConfect.layer(registry))),
);

it.effect("takes HTTP prefixes from an App value", () =>
  Effect.gen(function* () {
    const test = yield* TestConfect.TestConfect<typeof registry.schema>();
    const response = yield* test.fetch("/test-counter/members/7");
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toBe("7");
  }).pipe(Effect.provide(TestConfect.layer(app, registry))),
);

it.effect("fetches a nested installation through its declared prefixes", () =>
  Effect.gen(function* () {
    const test = yield* TestConfect.TestConfect<typeof registry.schema>();
    const response = yield* test.fetch("/left/deep/child/child/members/9");
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toBe("9");
  }).pipe(Effect.provide(TestConfect.layer(registry))),
);
