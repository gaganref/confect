import { TestConfect } from "@confect/test";
import { beforeEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import { App, Mount } from "@confect/core";
import {
  componentsGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  type FunctionReference,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import Counter from "../../server/test/local-backend/fixtures/components/counter/client";
import counter from "../../server/test/local-backend/fixtures/components/counter/convex/convex.config";
import env from "../../server/test/local-backend/fixtures/confect/env";
import registry from "../../server/test/local-backend/fixtures/confect/_generated/testing";
import refs from "../../server/test/local-backend/fixtures/confect/_generated/refs";

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

it.effect("registers a local mount and its nested child", () =>
  Effect.gen(function* () {
    const test = yield* TestConfect.TestConfect<typeof registry.schema>();
    const { right } = yield* test.mutation(
      refs.public.groups.components.exercise,
      { run: "kit" },
    );
    expect(right).toEqual([13]);
  }).pipe(Effect.provide(TestConfect.layer(registry))),
);

it.effect("fetches a nested route under a local mount", () =>
  Effect.gen(function* () {
    const test = yield* TestConfect.TestConfect<typeof registry.schema>();
    const response = yield* test.fetch("/right/child/members/5");
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toBe("5");
  }).pipe(Effect.provide(TestConfect.layer(registry))),
);

it.effect("names the mount whose test kit exports no register", () =>
  Effect.gen(function* () {
    const defect = yield* TestConfect.TestConfect<
      typeof registry.schema
    >().pipe(
      Effect.provide(
        TestConfect.layer({
          ...registry,
          // A CommonJS kit's exports are only known once it runs.
          components: { ...registry.components, right: {} as never },
        }),
      ),
      Effect.asVoid,
      Effect.catchDefect(Effect.succeed),
    );
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
    const defect = yield* TestConfect.TestConfect<
      typeof registry.schema
    >().pipe(
      Effect.provide(
        TestConfect.layer({
          ...registry,
          components: {
            ...registry.components,
            right: { schema: defineSchema({}) } as never,
          },
        }),
      ),
      Effect.asVoid,
      Effect.catchDefect(Effect.succeed),
    );
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

it.effect("registers a component through its test entry's register", () =>
  Effect.gen(function* () {
    const test = yield* TestConfect.TestConfect<typeof registry.schema>();
    const response = yield* test.fetch("/first/members/3");
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toBe("3");
  }).pipe(
    Effect.provide(
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
    ),
  ),
);

// A component whose `tick` schedules its own next run forever, as the official
// crons component's `public:rescheduler` does.
const tick = makeFunctionReference<"mutation">("public:tick");
const beat = {
  schema: defineSchema({ beats: defineTable({ n: v.number() }) }),
  modules: {
    "_generated/server.ts": () => Promise.resolve({}),
    "public.ts": () =>
      Promise.resolve({
        tick: mutationGeneric({
          args: {},
          handler: (ctx) =>
            ctx.db
              .insert("beats", { n: 0 })
              .then(() => ctx.scheduler.runAfter(1000, tick, {}))
              .then(() => null),
        }),
      }),
  },
};

it.effect(
  "hands a kit's standing sources to the backend, so the test kernel's drain ends with their next run pending",
  () =>
    Effect.gen(function* () {
      vi.doMock("convex-test", () => import("../src/internal/ConvexTest"));
      // The modules reset before each test, so the service keys come from the
      // same fresh imports as the layer.
      const [{ TestConfect: OnKernel }, { DatabaseSchema, MutationCtx }] =
        yield* Effect.promise(() =>
          Promise.all([import("@confect/test"), import("@confect/server")]),
        );
      const host = DatabaseSchema.make({});
      const start = (
        componentsGeneric() as unknown as {
          readonly beat: {
            readonly public: {
              readonly tick: FunctionReference<"mutation", "internal">;
            };
          };
        }
      ).beat.public.tick;
      yield* Effect.gen(function* () {
        const test = yield* OnKernel.TestConfect<typeof host>();
        yield* test.run(
          Effect.gen(function* () {
            const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
            yield* Effect.promise(() => ctx.runMutation(start, {}));
          }),
        );
        yield* test.finishAllScheduledFunctions(() => {});
      }).pipe(
        Effect.provide(
          OnKernel.layer(
            host,
            defineSchema({}),
            { "_generated/server.ts": () => Promise.resolve({}) },
            {
              register: (registerComponent) =>
                registerComponent("beat", beat.schema, beat.modules, {
                  standing: ["public:tick"],
                }),
            },
          ),
        ),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => vi.doUnmock("convex-test")))),
);
