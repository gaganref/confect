import { TestBackend, TestConfect } from "@confect/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import registry from "../../../tools/local-backend/fixtures/confect/_generated/testing";
import refs from "../../../tools/local-backend/fixtures/confect/_generated/refs";

const backend = TestBackend.make(registry, {
  refs: {},
  groups: {},
  ports: {},
  laws: [],
  obligations: [],
  manifestDigest: "sha256:fixture",
  mounts: [
    {
      path: "first",
      kit: "local",
      env: { COMPONENT_REQUIRED: { value: "first-required" } },
      required: ["COMPONENT_REQUIRED"],
    },
    {
      path: "second",
      kit: "local",
      env: { COMPONENT_REQUIRED: { value: "second-required" } },
      required: ["COMPONENT_REQUIRED"],
    },
  ],
  settings: [],
});

describe("a component mounted twice", () => {
  it.effect(
    "evaluates each mount's own copy of its modules, a helper they import included, under that mount's settings",
    () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(backend.layer({ config: {} }));
        const environment = yield* Effect.gen(function* () {
          const test = yield* TestConfect.TestConfect<typeof registry.schema>();
          return yield* test.query(
            refs.public.groups.components.environment,
            {},
          );
        }).pipe(Effect.provideContext(services));
        expect([environment.first.loaded, environment.second.loaded]).toEqual([
          "first-required",
          "second-required",
        ]);
        // Each copy draws from the backend's stream as it loads.
        expect(environment.first.drawn).not.toBe(environment.second.drawn);
      }),
    { timeout: 30000 },
  );

  it.effect(
    "refuses a second mount's load when nothing gives the files it imports their own copy",
    () =>
      Effect.gen(function* () {
        const load = (mount: "first" | "second") =>
          Effect.tryPromise({
            try: () => registry.components[mount].modules["counter.ts"](),
            catch: (cause) => String(cause),
          });
        yield* load("first");
        yield* load("second");
        // A copy already loaded sets nothing again, as without the plugin.
        const installed = Symbol.for("@confect/test/Vite");
        const global = globalThis as Record<symbol, unknown>;
        const refused = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const held = global[installed];
            delete global[installed];
            return held;
          }),
          () => load("second").pipe(Effect.asVoid, Effect.flip),
          (held) =>
            Effect.sync(() => {
              global[installed] = held;
            }),
        );
        expect(refused).toContain(
          'Mounts "first" and "second" both load ../../components/counter/convex/counter.ts',
        );
      }),
  );
});
