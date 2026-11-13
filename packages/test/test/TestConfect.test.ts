import { TestConfect } from "@confect/test";
import * as Layer from "effect/Layer";
import { beforeEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import { App, Mount } from "@confect/core";
import { defineSchema } from "convex/server";
import Counter from "../../../tools/local-backend/fixtures/components/counter/client";
import counter from "../../../tools/local-backend/fixtures/components/counter/convex/convex.config";
import env from "../../../tools/local-backend/fixtures/confect/env";
import registry from "../../../tools/local-backend/fixtures/confect/_generated/testing";
import refs from "../../../tools/local-backend/fixtures/confect/_generated/refs";

beforeEach(() => vi.resetModules());

const app = App.make({
  env,
  components: [counter],
  mounts: [
    Mount.make(Counter, {
      name: "first",
      httpPrefix: "/test-counter",
      env: { COMPONENT_REQUIRED: "fixture" },
    }),
  ],
});

it.effect(
  "registers declared authored components for callbacks and mounted HTTP",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(TestConfect.layer(registry));
      return yield* Effect.gen(function* () {
        const test = yield* TestConfect.TestConfect<typeof registry.schema>();
        const callbacks = refs.public.groups.callbacks;
        const id = yield* test.mutation(callbacks.send, {
          run: "declared-app",
        });
        yield* test.mutation(callbacks.setStatus, { id, status: "delivered" });
        const query2 = yield* test.query(callbacks.events, {
          run: "declared-app",
        });
        expect(query2).toEqual(["delivered"]);
        const response = yield* test.fetch("/first/members/42");
        expect(response.status).toBe(200);
        const resolved = yield* Effect.promise(() => response.json());
        expect(resolved).toBe("42");
      }).pipe(Effect.provideContext(services));
    }),
);

it.effect("registers a local mount and its nested child", () =>
  Effect.gen(function* () {
    const services2 = yield* Layer.build(TestConfect.layer(registry));
    return yield* Effect.gen(function* () {
      const test = yield* TestConfect.TestConfect<typeof registry.schema>();
      const { right } = yield* test.mutation(
        refs.public.groups.components.exercise,
        { run: "kit" },
      );
      expect(right).toEqual([13]);
    }).pipe(Effect.provideContext(services2));
  }),
);

it.effect("fetches a nested route under a local mount", () =>
  Effect.gen(function* () {
    const services3 = yield* Layer.build(TestConfect.layer(registry));
    return yield* Effect.gen(function* () {
      const test = yield* TestConfect.TestConfect<typeof registry.schema>();
      const response = yield* test.fetch("/right/child/members/5");
      expect(response.status).toBe(200);
      const resolved = yield* Effect.promise(() => response.json());
      expect(resolved).toBe("5");
    }).pipe(Effect.provideContext(services3));
  }),
);

it.effect("names the mount whose test kit exports no register", () =>
  Effect.gen(function* () {
    const defect = yield* Effect.gen(function* () {
      const services4 = yield* Layer.build(
        TestConfect.layer({
          ...registry,
          // A CommonJS kit's exports are only known once it runs.
          components: { ...registry.components, right: {} as never },
        }),
      );
      return yield* TestConfect.TestConfect<typeof registry.schema>().pipe(
        Effect.provideContext(services4),
      );
    }).pipe(Effect.scoped, Effect.asVoid, Effect.catchDefect(Effect.succeed));
    expect(defect).toMatchObject({
      _tag: "InvalidComponentKit",
      componentPath: "right",
      message:
        'The test kit for "right" must export register(t, name), or schema and modules.',
    });
  }),
);

it.effect("names the mount whose test kit exports schema without modules", () =>
  Effect.gen(function* () {
    const defect = yield* Effect.gen(function* () {
      const services5 = yield* Layer.build(
        TestConfect.layer({
          ...registry,
          components: {
            ...registry.components,
            right: { schema: defineSchema({}) } as never,
          },
        }),
      );
      return yield* TestConfect.TestConfect<typeof registry.schema>().pipe(
        Effect.provideContext(services5),
      );
    }).pipe(Effect.scoped, Effect.asVoid, Effect.catchDefect(Effect.succeed));
    expect(defect).toMatchObject({
      _tag: "InvalidComponentKit",
      componentPath: "right",
      message:
        'The test kit for "right" must export register(t, name), or schema and modules.',
    });
  }),
);

it.effect("takes HTTP prefixes from an App value", () =>
  Effect.gen(function* () {
    const services6 = yield* Layer.build(TestConfect.layer(app, registry));
    return yield* Effect.gen(function* () {
      const test = yield* TestConfect.TestConfect<typeof registry.schema>();
      const response = yield* test.fetch("/test-counter/members/7");
      expect(response.status).toBe(200);
      const resolved = yield* Effect.promise(() => response.json());
      expect(resolved).toBe("7");
    }).pipe(Effect.provideContext(services6));
  }),
);

it.effect("skips the holes in an App value's sparse list of mounts", () => {
  const mounts: Array<(typeof app.mounts)[number]> = [];
  mounts[1] = app.mounts[0];
  const sparse = App.make({ env, components: [counter], mounts });
  return Effect.gen(function* () {
    const services7 = yield* Layer.build(TestConfect.layer(sparse, registry));
    return yield* Effect.gen(function* () {
      const test = yield* TestConfect.TestConfect<typeof registry.schema>();
      const response = yield* test.fetch("/test-counter/members/7");
      expect(response.status).toBe(200);
    }).pipe(Effect.provideContext(services7));
  });
});

it.effect("fetches a nested installation through its declared prefixes", () =>
  Effect.gen(function* () {
    const services8 = yield* Layer.build(TestConfect.layer(registry));
    return yield* Effect.gen(function* () {
      const test = yield* TestConfect.TestConfect<typeof registry.schema>();
      const response = yield* test.fetch("/left/deep/child/child/members/9");
      expect(response.status).toBe(200);
      const resolved = yield* Effect.promise(() => response.json());
      expect(resolved).toBe("9");
    }).pipe(Effect.provideContext(services8));
  }),
);

it.effect("registers a component through its test entry's register", () =>
  Effect.gen(function* () {
    const services9 = yield* Layer.build(
      TestConfect.layer({
        ...registry,
        components: {
          ...registry.components,
          first: {
            register: (t, name) =>
              t.registerComponent(
                name,
                registry.components.first.schema,
                registry.components.first.modules,
              ),
          },
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const test = yield* TestConfect.TestConfect<typeof registry.schema>();
      const response = yield* test.fetch("/first/members/3");
      expect(response.status).toBe(200);
      const resolved = yield* Effect.promise(() => response.json());
      expect(resolved).toBe("3");
    }).pipe(Effect.provideContext(services9));
  }),
);
