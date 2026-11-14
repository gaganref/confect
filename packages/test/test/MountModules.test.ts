import { Env } from "@confect/core";
import * as MutationCtx from "@confect/server/MutationCtx";
import { TestBackend, TestConfect } from "@confect/test";
import { describe, expect, it } from "@effect/vitest";
import {
  componentsGeneric,
  type FunctionReference,
  type GenericDataModel,
} from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

const components = componentsGeneric() as unknown as Record<
  "left" | "right",
  { readonly parent: { readonly shared: FunctionReference<"query"> } }
>;

/**
 * Open a session, then run `use` in it.
 */
const inSession = <A, E>(
  use: (
    test: TestConfect.TestConfect<typeof registry.schema>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(backend.layer({ config: {} }));
    return yield* Effect.gen(function* () {
      const test = yield* TestConfect.TestConfect<typeof registry.schema>();
      return yield* use(test);
    }).pipe(Effect.provideContext(services));
  });

const environment = inSession((test) =>
  test.query(refs.public.groups.components.environment, {}),
);

/**
 * What the helper outside every component's folder drew for `mount`'s copy of
 * `parent`.
 */
const parentDraw = (mount: "left" | "right") =>
  inSession((test) =>
    test.run(
      Effect.gen(function* () {
        const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
        return yield* Effect.promise(() =>
          ctx.runQuery(components[mount].parent.shared, {}),
        );
      }),
      Schema.Finite,
    ),
  );

const sharedLoaded = new URL(
  "../../../tools/local-backend/fixtures/components/sharedLoaded.ts",
  import.meta.url,
).pathname;

/**
 * One mount's copy of the helper outside every component's folder, loaded as
 * generated `testing.ts` loads a mount's module.
 */
const sharedCopy = (mount: string) =>
  Effect.promise(
    () =>
      import(
        /* @vite-ignore */ `${sharedLoaded}?confect-mount=${encodeURIComponent(mount)}`
      ) as Promise<{
        readonly drawn: number;
        readonly packageSchema: unknown;
        readonly packageEnv: unknown;
      }>,
  );

describe("a component mounted twice", () => {
  it.effect(
    "evaluates each mount's own copy of its modules, a helper inside its folder included, under that mount's settings",
    () =>
      Effect.gen(function* () {
        const { first, second } = yield* environment;
        expect([first.loaded, second.loaded]).toEqual([
          "first-required",
          "second-required",
        ]);
        // Each copy draws from the backend's stream as it loads.
        expect(first.drawn).not.toBe(second.drawn);
      }),
    { timeout: 30000 },
  );

  it.effect(
    "gives each mount its own copy of a helper outside the component's folder",
    () =>
      Effect.gen(function* () {
        const { first, second } = yield* environment;
        expect([first.outside, second.outside]).toEqual([
          "first-required",
          "second-required",
        ]);
      }),
    { timeout: 30000 },
  );

  it.effect(
    "gives each mount its own copy of a helper in the app's own folder",
    () =>
      Effect.gen(function* () {
        const { first, second } = yield* environment;
        expect([first.app, second.app]).toEqual([
          "first-required",
          "second-required",
        ]);
      }),
    { timeout: 30000 },
  );

  it.effect(
    "gives each mount of either of two components its own copy of a helper both import",
    () =>
      Effect.gen(function* () {
        const { first, second } = yield* environment;
        const left = yield* parentDraw("left");
        const right = yield* parentDraw("right");
        const draws = [first.outsideDrawn, second.outsideDrawn, left, right];
        expect(new Set(draws).size).toBe(draws.length);
      }),
    { timeout: 30000 },
  );

  it.effect(
    "gives each mount its own copy of a file three imports below its module",
    () =>
      Effect.gen(function* () {
        const { first, second } = yield* environment;
        expect([first.chain, second.chain]).toEqual([
          "first-required",
          "second-required",
        ]);
      }),
    { timeout: 30000 },
  );

  it.effect(
    "shares one copy of a package under node_modules across mounts, where a deployment gives each mount its own",
    () =>
      Effect.gen(function* () {
        const one = yield* sharedCopy("package-one");
        const two = yield* sharedCopy("package-two");
        expect(one.drawn).not.toBe(two.drawn);
        // The pinned limit: effect is one instance for the kernel and every mount.
        expect(one.packageSchema).toBe(Schema.String);
        expect(two.packageSchema).toBe(Schema.String);
        // So is @confect/core, which this repo's tests alias to its source.
        expect(one.packageEnv).toBe(Env);
        expect(two.packageEnv).toBe(Env);
      }),
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
