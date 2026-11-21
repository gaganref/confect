// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of fresh Node processes.
import { spawnSync } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A packaged read carries the SHA-256 codegen would record for its bytes.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Preflight, Sources, TestConfect } from "@confect/test";
import { DatabaseSchema, MutationCtx } from "@confect/server";
import * as PushCheck from "@confect/server/PushCheck";
import * as Layer from "effect/Layer";
import { beforeEach, expect, expectTypeOf, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { App, Mount, Ref, Table } from "@confect/core";
import {
  componentsGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import Counter from "../../../tools/local-backend/fixtures/components/counter/client";
import counter from "../../../tools/local-backend/fixtures/components/counter/convex/convex.config";
import env from "../../../tools/local-backend/fixtures/confect/env";
import registry from "../../../tools/local-backend/fixtures/confect/_generated/testing";
import refs from "../../../tools/local-backend/fixtures/confect/_generated/refs";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as Json from "../src/internal/Json";
import { assertIs } from "./internal/assertIs";
import { diedWith } from "./internal/diedWith";
import {
  pushChecked,
  pushCheckedRefs,
  pushCheckRefusal,
} from "./fixtures/pushChecked";

beforeEach(() => vi.resetModules());

const app = App.make({
  env,
  components: [counter],
  mounts: [
    Mount.make(Counter, {
      name: "first",
      httpPrefix: "/test-counter",
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

const host = DatabaseSchema.make({});
const Host = TestConfect.TestConfect<typeof host>();
const generatedOnly = { "_generated/server.ts": () => Promise.resolve({}) };

const notes = {
  add: makeFunctionReference<"mutation", { text: string }>("notes:add"),
  list: makeFunctionReference<"query", {}, Array<string>>("notes:list"),
};
const texts = (rows: ReadonlyArray<{ readonly text: string }>) =>
  Arr.map(rows, (row) => row.text);
const listModule = (table: string) => ({
  add: mutationGeneric({
    args: { text: v.string() },
    handler: (ctx, { text }) => ctx.db.insert(table, { text }).then(() => null),
  }),
  list: queryGeneric({
    args: {},
    handler: (ctx) => ctx.db.query(table).collect().then(texts),
  }),
});
const hostSchema = defineSchema({ notes: defineTable({ text: v.string() }) });
const hostModules = {
  ...generatedOnly,
  "notes.ts": () => Promise.resolve(listModule("notes")),
};
const store = {
  schema: defineSchema({ rows: defineTable({ text: v.string() }) }),
  modules: {
    ...generatedOnly,
    "rows.ts": () => Promise.resolve(listModule("rows")),
  },
};

// A component whose `tick` schedules its own next run forever, as the official
// crons component's `public:rescheduler` does.
const tick = makeFunctionReference<"mutation">("public:tick");
const beat = {
  schema: defineSchema({ beats: defineTable({ n: v.number() }) }),
  modules: {
    ...generatedOnly,
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

const mounted = componentsGeneric() as unknown as {
  readonly store: {
    readonly rows: {
      readonly add: FunctionReference<"mutation", "internal", { text: string }>;
      readonly list: FunctionReference<"query", "internal", {}, Array<string>>;
    };
  };
  readonly beat: {
    readonly public: {
      readonly tick: FunctionReference<"mutation", "internal">;
    };
  };
};

const withCtx = <A>(
  use: (ctx: MutationCtx.MutationCtx<GenericDataModel>) => Promise<A>,
) =>
  Effect.gen(function* () {
    const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
    return yield* Effect.promise(() => use(ctx));
  });

// One program: a direct write, a component call, a scheduled function and a
// drain, read back.
const program = Effect.gen(function* () {
  const test = yield* Host;
  yield* test.run(
    withCtx((ctx) =>
      ctx.db
        .insert("notes", { text: "direct" })
        .then(() =>
          ctx.runMutation(mounted.store.rows.add, { text: "component" }),
        )
        .then(() =>
          ctx.scheduler.runAfter(0, notes.add, { text: "scheduled" }),
        ),
    ),
  );
  yield* test.finishAllScheduledFunctions(() => vi.runAllTimers());
  return yield* test.run(
    withCtx((ctx) =>
      Promise.all([
        ctx.runQuery(notes.list, {}),
        ctx.runQuery(mounted.store.rows.list, {}),
      ]).then(([hostNotes, rows]) => ({ notes: hostNotes, rows })),
    ),
    Schema.Struct({
      notes: Schema.String.pipe(Schema.Array, Schema.mutable),
      rows: Schema.String.pipe(Schema.Array, Schema.mutable),
    }),
  );
});

it.effect.each([{ target: "convex-test" }, { target: "kernel" }] as const)(
  "runs one program the same way on $target",
  ({ target }) =>
    Effect.gen(function* () {
      const services15 = yield* Layer.build(
        TestConfect.layer(host, hostSchema, hostModules, {
          target,
          register: (registerComponent) =>
            registerComponent("store", store.schema, store.modules),
        }),
      );
      return yield* Effect.gen(function* () {
        vi.useFakeTimers();
        const programValue = yield* program;
        expect(programValue).toEqual({
          notes: ["direct", "scheduled"],
          rows: ["component"],
        });
      }).pipe(
        Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
        Effect.provideContext(services15),
      );
    }).pipe(Effect.scoped),
);

const drainBeat = (standing: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    const services14 = yield* Layer.build(
      TestConfect.layer(host, defineSchema({}), generatedOnly, {
        target: "kernel",
        register: (registerComponent) =>
          registerComponent(
            "beat",
            beat.schema,
            beat.modules,
            standing === undefined ? undefined : { standing },
          ),
      }),
    );
    return yield* Effect.gen(function* () {
      const test = yield* Host;
      yield* test.run(
        withCtx((ctx) => ctx.runMutation(mounted.beat.public.tick, {})),
      );
      yield* test.finishAllScheduledFunctions(() => {});
    }).pipe(Effect.provideContext(services14));
  }).pipe(Effect.scoped);

it.effect(
  "on the kernel target, a kit's standing source lets the drain end and an undeclared one fails its budget",
  () =>
    Effect.gen(function* () {
      yield* drainBeat(["public:tick"]);
      const exit = yield* Effect.exit(drainBeat(undefined));
      assertIs(exit, Exit.isFailure);
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "DrainBudgetExceeded",
        pending: [{ componentPath: "beat", name: "public:tick" }],
      });
    }),
);

// convex-test advances the test's timers while it drains. The kernel keeps its
// own clock and never does, so the callback shows which target ran.
const advancesTimers = Effect.gen(function* () {
  const test = yield* TestConfect.TestConfect<typeof registry.schema>();
  let advanced = false;
  yield* test.finishAllScheduledFunctions(() => {
    advanced = true;
  });
  return advanced;
});

// The fixture's module sources, which its plain Convex actions need on the
// kernel. Row 8's generated registry supplies them.
const localSources = import.meta.glob<string>(
  "../../../tools/local-backend/fixtures/convex/**/*.ts",
  { query: "?raw", import: "default" },
);

it.effect.each([
  {
    form: "declared app",
    layer: (options: TestConfect.LayerOptions) =>
      TestConfect.layer(registry, options),
  },
  {
    form: "app and registry",
    layer: (options: TestConfect.LayerOptions) =>
      TestConfect.layer(app, registry, options),
  },
  {
    form: "schema and modules",
    layer: (options: TestConfect.LayerOptions) =>
      TestConfect.layer(
        registry.schema,
        registry.convexSchema,
        registry.modules,
        options,
      ),
  },
])("the $form form runs on the target it names", ({ layer }) =>
  Effect.gen(function* () {
    const advancesTimersResult = yield* Effect.gen(function* () {
      const services13 = yield* Layer.build(layer({}));
      return yield* advancesTimers.pipe(Effect.provideContext(services13));
    }).pipe(Effect.scoped);
    expect(advancesTimersResult).toBe(true);
    const advancesTimersResult2 = yield* Effect.gen(function* () {
      const services12 = yield* Layer.build(
        layer({ target: "kernel", sources: localSources }),
      );
      return yield* advancesTimers.pipe(Effect.provideContext(services12));
    }).pipe(Effect.scoped);
    expect(advancesTimersResult2).toBe(false);
  }),
);

it("on the kernel target, an app with an hourly cron opens, two processes with one seed replay its runs byte for byte, and another seed moves its jitter", () => {
  const loader = pathToFileURL(
    createRequire(import.meta.url).resolve("tsx/esm"),
  ).href;
  const script = fileURLToPath(
    new URL("fixtures/testConfectCronReplay.ts", import.meta.url),
  );
  const replay = (...seed: Array<string>) =>
    spawnSync(process.execPath, ["--import", loader, script, ...seed], {
      encoding: "utf8",
    });
  const [one, two, other] = [replay(), replay(), replay("7")];
  expect(
    Arr.flatMap([one, two, other], ({ status, stderr }) => [status, stderr]),
  ).toEqual([0, "", 0, "", 0, ""]);
  expect(one.stdout).toBe(two.stdout);
  const hourly = (stdout: string) =>
    pipe(
      Json.parse(stdout) as Array<{ name: string; at: number }>,
      Arr.filter(({ name }) => name === "hourly"),
      Arr.map(({ at }) => at),
    );
  expect(hourly(one.stdout)).toHaveLength(2);
  expect(hourly(other.stdout)).toHaveLength(2);
  expect(hourly(other.stdout)).not.toEqual(hourly(one.stdout));
}, 120_000);
const vaultCanary = "canary-vault-9a6e3f10";
const vault = DatabaseSchema.make({
  keys: Table.make(() =>
    Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) }),
  )("keys"),
});
const Vault = TestConfect.TestConfect<typeof vault>();

it.effect(
  "on the kernel target, a value under a secret node of the app's table schema reaches a failure report as a marker",
  () =>
    Effect.gen(function* () {
      const services11 = yield* Layer.build(
        TestConfect.layer(
          vault,
          defineSchema({ keys: defineTable({ token: v.string() }) }),
          generatedOnly,
          { target: "kernel" },
        ),
      );
      return yield* Effect.gen(function* () {
        const test = yield* Vault;
        yield* test.run(
          withCtx((ctx) => ctx.db.insert("keys", { token: vaultCanary })),
        );
        const exit = yield* Effect.exit(
          test.run(
            withCtx((ctx) =>
              ctx.db
                .query("keys")
                .first()
                .then((key) => {
                  throw new Error(`the stored key is ${key!.token as string}`);
                }),
            ),
          ),
        );
        assertIs(exit, Exit.isFailure);
        const report = Cause.pretty(exit.cause);
        expect(report).toContain("the stored key is [redacted]");
        expect(report).not.toContain(vaultCanary);
      }).pipe(Effect.provideContext(services11));
    }).pipe(Effect.scoped),
);

const hookCanary = "canary-hook-5d2a7c90";

it.effect(
  "on the kernel target, the layer's secret policy hook marks a table the app's Confect schema does not declare",
  () =>
    Effect.gen(function* () {
      const services10 = yield* Layer.build(
        TestConfect.layer(
          vault,
          defineSchema({
            keys: defineTable({ token: v.string() }),
            tokens: defineTable({ token: v.string() }),
          }),
          generatedOnly,
          {
            target: "kernel",
            secrets: {
              tables: {
                "": {
                  tokens: () =>
                    Schema.Struct({
                      token: Schema.RedactedFromValue(Schema.String),
                    }),
                },
              },
            },
          },
        ),
      );
      return yield* Effect.gen(function* () {
        const test = yield* Vault;
        yield* test.run(
          withCtx((ctx) => ctx.db.insert("tokens", { token: hookCanary })),
        );
        const exit = yield* Effect.exit(
          test.run(
            withCtx((ctx) =>
              ctx.db
                .query("tokens")
                .first()
                .then((row) => {
                  throw new Error(
                    `the stored token is ${row!.token as string}`,
                  );
                }),
            ),
          ),
        );
        assertIs(exit, Exit.isFailure);
        const report = Cause.pretty(exit.cause);
        expect(report).toContain("the stored token is [redacted]");
        expect(report).not.toContain(hookCanary);
      }).pipe(Effect.provideContext(services10));
    }).pipe(Effect.scoped),
);

// A plain Convex "use node" action, whose runtime the kernel can read only from
// its module's source.
const runtimeModules = import.meta.glob(
  "./fixtures/runtime/{_generated/server,plainNode}.ts",
);
const runtimeSources = import.meta.glob<string>(
  "./fixtures/runtime/{_generated/server,plainNode}.ts",
  { query: "?raw", import: "default" },
);
const runtimeRegistry = {
  schema: DatabaseSchema.make({}),
  convexSchema: defineSchema({}),
  modules: runtimeModules,
  components: {},
};
const nodeSurface = Ref.fromFunctionReference(
  makeFunctionReference<
    "action",
    {},
    { setImmediate: string; queueMicrotask: string }
  >("plainNode:surface"),
  "action",
);
const surface = Effect.gen(function* () {
  const test = yield* TestConfect.TestConfect<typeof runtimeRegistry.schema>();
  return yield* test.action(nodeSurface);
});
// `surface` on a fresh backend the layer builds.
const surfaceOn = <E>(
  layer: Layer.Layer<TestConfect.TestConfect<typeof runtimeRegistry.schema>, E>,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layer);
    return yield* surface.pipe(Effect.provideContext(services));
  });
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      assertIs(exit, Exit.isFailure);
      return Cause.squash(exit.cause);
    }),
  );
const node = { setImmediate: "function", queueMicrotask: "function" };

it.effect.each([
  {
    form: "declared app",
    layer: (options: TestConfect.LayerOptions) =>
      TestConfect.layer({ ...runtimeRegistry, httpMounts: [] }, options),
  },
  {
    form: "app and registry",
    layer: (options: TestConfect.LayerOptions) =>
      TestConfect.layer(App.make({ env }), runtimeRegistry, options),
  },
  {
    form: "schema and modules",
    layer: (options: TestConfect.LayerOptions) =>
      TestConfect.layer(
        runtimeRegistry.schema,
        runtimeRegistry.convexSchema,
        runtimeRegistry.modules,
        options,
      ),
  },
])(
  'on the kernel target, the $form form takes sources, so a plain "use node" action runs in Node, and without them it is refused',
  ({ layer }) =>
    Effect.gen(function* () {
      const ran = yield* surfaceOn(
        layer({ target: "kernel", sources: runtimeSources }),
      );
      const refused = yield* surfaceOn(layer({ target: "kernel" })).pipe(
        refusalOf,
      );
      expect(ran).toEqual(node);
      expect(refused).toMatchObject({
        _tag: "ActionRuntimeUnknown",
        componentPath: "",
        module: "plainNode",
        exports: ["surface"],
      });
    }),
);

it.effect(
  "on the kernel target, a generated registry's sources reach the kernel, and a layer's own take their place",
  () =>
    Effect.gen(function* () {
      const generated = {
        ...runtimeRegistry,
        httpMounts: [],
        sources: runtimeSources,
      };
      const ran = yield* surfaceOn(
        TestConfect.layer(generated, { target: "kernel" }),
      );
      // A layer's own sources replace the registry's: here, none of the
      // modules', so the module is refused as one without a source.
      const refused = yield* surfaceOn(
        TestConfect.layer(generated, { target: "kernel", sources: {} }),
      ).pipe(refusalOf);
      expect(ran).toEqual(node);
      expect(refused).toMatchObject({
        _tag: "ModuleRuntime",
        reason: "missingSource",
      });
    }),
);

it.effect(
  "on the kernel target, a generated registry's packaged sources reach a kit that registers without its own, unless the layer declares the component's runtime",
  () =>
    Effect.gen(function* () {
      // A package's kit, which registers its modules without their sources.
      const kit = (sources?: Record<string, () => Promise<string>>) => ({
        register: (
          t: { readonly registerComponent: TestConfect.RegisterComponent },
          name: string,
        ) =>
          t.registerComponent(
            name,
            defineSchema({}),
            runtimeModules,
            sources === undefined ? undefined : { sources },
          ),
      });
      // What generated `testing.ts` reads for a packaged mount: here the kit's
      // own module files, with the digests codegen would record.
      const packageRead =
        (sources: Record<string, () => Promise<string>>) => () =>
          Promise.all(
            Arr.map(Rec.toEntries(sources), ([key, read]) =>
              read().then((text) => {
                const bytes = new TextEncoder().encode(text);
                return {
                  file: pipe(key, Str.replace("./fixtures/runtime/", "")),
                  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                  bytes,
                };
              }),
            ),
          ).then((files) => ({ steps: [], files }));
      const generated = (
        packaged: Record<string, () => Promise<string>>,
        kitSources?: Record<string, () => Promise<string>>,
      ) => ({
        ...runtimeRegistry,
        httpMounts: [],
        sources: runtimeSources,
        components: { kit: kit(kitSources) },
        packagedSources: { kit: packageRead(packaged) },
      });
      const ran = yield* surfaceOn(
        TestConfect.layer(generated(runtimeSources), {
          target: "kernel",
        }),
      );
      // A read that names none of the kit's modules shows the registry's are
      // the sources the kernel read.
      const refused = yield* surfaceOn(
        TestConfect.layer(generated({}), { target: "kernel" }),
      ).pipe(refusalOf);
      const declared = yield* surfaceOn(
        TestConfect.layer(generated({}), {
          target: "kernel",
          componentRuntimes: { kit: "node" },
        }),
      );
      const kitOwn = yield* surfaceOn(
        TestConfect.layer(generated({}, runtimeSources), {
          target: "kernel",
        }),
      );
      expect(ran).toEqual(node);
      expect(refused).toMatchObject({
        _tag: "ModuleRuntime",
        reason: "missingSource",
        componentPath: "kit",
      });
      expect(declared).toEqual(node);
      expect(kitOwn).toEqual(node);
    }),
);

it.effect(
  "on the kernel target, refuses a packaged mount whose layout codegen recorded as unsupported, until the layer declares its runtime",
  () =>
    Effect.gen(function* () {
      const generated = {
        ...runtimeRegistry,
        httpMounts: [],
        sources: runtimeSources,
        components: {
          kit: {
            register: (
              t: { readonly registerComponent: TestConfect.RegisterComponent },
              name: string,
            ) => t.registerComponent(name, defineSchema({}), runtimeModules),
          },
        },
        packagedSources: {
          kit: {
            mount: "kit",
            package: "tool",
            reason: "config-siblings",
          } satisfies TestConfect.UnsupportedPackage,
        },
      };
      const refused = yield* Layer.build(
        TestConfect.layer(generated, { target: "kernel" }),
      ).pipe(
        Effect.as("opened" as const),
        Effect.catchTag("PackagedLayoutUnsupported", (error) =>
          Effect.succeed(error),
        ),
        Effect.orDie,
      );
      const declared = yield* surfaceOn(
        TestConfect.layer(generated, {
          target: "kernel",
          componentRuntimes: { kit: "node" },
        }),
      );
      expect(refused).toMatchObject({
        _tag: "PackagedLayoutUnsupported",
        mount: "kit",
        package: "tool",
        reason: "config-siblings",
      });
      expect((refused as Error).message).toContain(
        'componentRuntimes: { "kit": "isolate" }',
      );
      expect(declared).toEqual(node);
    }).pipe(Effect.scoped),
);

it("takes a packaged read whose missing values the generated reader writes as undefined", () => {
  // Generated `testing.ts` compiles under `exactOptionalPropertyTypes`, where
  // its reader writes a value it has none for as `undefined`.
  const read: TestConfect.PackageRead = {
    steps: [
      {
        package: "tool",
        version: undefined,
        manifest: undefined,
        manifestBytes: undefined,
        file: "convex.config.js",
        digest: "sha256:",
        from: "/",
        found: undefined,
        installed: undefined,
        bytes: undefined,
        failure: undefined,
      },
    ],
    files: [
      { file: "a.js", digest: "sha256:", bytes: undefined, failure: undefined },
    ],
  };
  expect(read.steps).toHaveLength(1);
});

const unregisteredModules = import.meta.glob(
  "./fixtures/runtime/{_generated/server,plainNode,unregistered}.ts",
);
const unregisteredSources = import.meta.glob<string>(
  "./fixtures/runtime/{_generated/server,plainNode,unregistered}.ts",
  { query: "?raw", import: "default" },
);
// The modules registered as the component `kit`, with `sources`.
const kitWithSources = (
  modules: Record<string, () => Promise<any>>,
  sources: Sources.Sources,
) =>
  TestConfect.layer(
    runtimeRegistry.schema,
    runtimeRegistry.convexSchema,
    runtimeRegistry.modules,
    {
      target: "kernel",
      sources: runtimeSources,
      register: (registerComponent) =>
        registerComponent("kit", defineSchema({}), modules, { sources }),
    },
  );

it.effect.each([
  { given: "an empty placeholder", text: "" },
  { given: "a lone directive", text: '"use node";\n' },
])(
  "on the kernel target, refuses a raw source that is no module Convex registers, for a module its loader loads: $given",
  ({ text }) =>
    Effect.gen(function* () {
      const refused = yield* surfaceOn(
        TestConfect.layer(
          runtimeRegistry.schema,
          runtimeRegistry.convexSchema,
          runtimeModules,
          {
            target: "kernel",
            sources: {
              ...runtimeSources,
              "./fixtures/runtime/plainNode.ts": () => Promise.resolve(text),
            },
          },
        ),
      ).pipe(refusalOf);
      expect(refused).toMatchObject({
        _tag: "ModuleRuntime",
        reason: "placeholderSource",
        module: "plainNode",
        message: expect.stringContaining("Sources.fromFiles"),
      });
    }),
);

it.effect(
  "on the kernel target, refuses a raw placeholder a kit passes to registerComponent, so a test that expects a failure never passes on the missing module",
  () =>
    Effect.gen(function* () {
      // A failure-only assertion would have passed on "Could not find module"
      // when the placeholder dropped the module.
      const refused = yield* surfaceOn(
        kitWithSources(runtimeModules, {
          ...runtimeSources,
          "./fixtures/runtime/plainNode.ts": () => Promise.resolve(""),
        }),
      ).pipe(refusalOf);
      expect(refused).toMatchObject({
        _tag: "ModuleRuntime",
        reason: "placeholderSource",
        componentPath: "kit",
        module: "plainNode",
      });
    }),
);

it.effect(
  "on the kernel target, refuses a raw ?raw glob of a real file with no import or export, which a kit wraps in Sources.fromFiles",
  () =>
    Effect.gen(function* () {
      const refused = yield* surfaceOn(
        kitWithSources(unregisteredModules, unregisteredSources),
      ).pipe(refusalOf);
      expect(refused).toMatchObject({
        _tag: "ModuleRuntime",
        reason: "placeholderSource",
        componentPath: "kit",
        module: "unregistered",
      });
    }),
);

it.effect(
  "on the kernel target, refuses a hand-written reader that forges the file-read mark",
  () =>
    Effect.gen(function* () {
      const forged = Object.assign(() => Promise.resolve(""), {
        [Symbol.for("@confect/kernel/fileSource")]: true,
      });
      const refused = yield* surfaceOn(
        kitWithSources(runtimeModules, {
          ...runtimeSources,
          "./fixtures/runtime/plainNode.ts": forged,
        }),
      ).pipe(refusalOf);
      expect(refused).toMatchObject({
        _tag: "ModuleRuntime",
        reason: "placeholderSource",
        componentPath: "kit",
        module: "plainNode",
      });
    }),
);

it("exports each public module and no path under internal/, so no import reaches the file-read mark", () => {
  const manifest = createRequire(import.meta.url)("../package.json") as {
    readonly exports: Readonly<Record<string, unknown>>;
  };
  expect(Rec.keys(manifest.exports)).toEqual([
    ".",
    "./Preflight",
    "./Sources",
    "./TestBackend",
    "./TestComponent",
    "./TestConfect",
    "./Vite",
    "./setup",
    "./package.json",
  ]);
  // Node's own resolver, from inside the package, which resolves its own
  // name; a wildcard export would map the doubled slash into dist/internal.
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--no-deprecation",
      "-e",
      'for (const specifier of ["@confect/test//internal/FileSources", "@confect/test/internal/FileSources"]) { try { console.log(import.meta.resolve(specifier)); } catch (error) { console.log(error.code); } }',
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  expect(pipe(probe.stdout, Str.trim, Str.split("\n"))).toEqual([
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
  ]);
});

it.effect(
  "on the kernel target, leaves unregistered a module whose file Sources.fromFiles read has no import or export, as Convex leaves it out",
  () =>
    Effect.gen(function* () {
      // unregistered.ts throws if the kernel loads it.
      const ran = yield* surfaceOn(
        kitWithSources(
          unregisteredModules,
          Sources.fromFiles(unregisteredSources),
        ),
      );
      expect(ran).toEqual(node);
    }),
);

it.effect(
  "on the kernel target, registers a raw source that exports, such as a placeholder of export {}",
  () =>
    Effect.gen(function* () {
      const ran = yield* surfaceOn(
        TestConfect.layer(
          runtimeRegistry.schema,
          runtimeRegistry.convexSchema,
          runtimeModules,
          {
            target: "kernel",
            sources: {
              ...runtimeSources,
              "./fixtures/runtime/plainNode.ts": () =>
                Promise.resolve('"use node";\nexport {};\n'),
            },
          },
        ),
      );
      expect(ran).toEqual(node);
    }),
);

it("types only a registry that says it has no packaged mount as a layer that cannot fail PackagedComponentChanged or PackagedLayoutUnsupported", () => {
  type App = TestConfect.DeclaredApp<typeof runtimeRegistry.schema>;
  type Session = TestConfect.TestConfect<typeof runtimeRegistry.schema>;
  // Never called: each one's return type is the overload it picks.
  const widened = (declared: Omit<App, "packagedSources">) =>
    TestConfect.layer(declared);
  const generic = (declared: App) => TestConfect.layer(declared);
  const marked = (declared: App & TestConfect.WithoutPackagedSources) =>
    TestConfect.layer(declared);
  expectTypeOf<ReturnType<typeof widened>>().toEqualTypeOf<
    Layer.Layer<Session, TestConfect.PackagedRefusal>
  >();
  expectTypeOf<ReturnType<typeof generic>>().toEqualTypeOf<
    Layer.Layer<Session, TestConfect.PackagedRefusal>
  >();
  expectTypeOf<ReturnType<typeof marked>>().toEqualTypeOf<
    Layer.Layer<Session>
  >();
  // A registry that records only unsupported layouts can still refuse.
  const unsupportedOnly = (
    declared: App & {
      readonly packagedSources: {
        readonly pool: TestConfect.UnsupportedPackage;
      };
    },
  ) => TestConfect.layer(declared);
  expectTypeOf<ReturnType<typeof unsupportedOnly>>().toEqualTypeOf<
    Layer.Layer<Session, TestConfect.PackagedRefusal>
  >();
  // Generated `testing.ts` for an app without a packaged mount says so.
  expectTypeOf(registry.packagedSources).toEqualTypeOf<undefined>();
});

it.effect(
  "on the kernel target, a component registered without sources is refused, naming it, until the layer declares its runtime or the kit passes its sources",
  () =>
    Effect.gen(function* () {
      const kitLayer = (
        options: TestConfect.LayerOptions,
        kitOptions?: TestConfect.RegisterOptions,
      ) =>
        TestConfect.layer(
          runtimeRegistry.schema,
          runtimeRegistry.convexSchema,
          runtimeRegistry.modules,
          {
            target: "kernel",
            sources: runtimeSources,
            register: (registerComponent) =>
              registerComponent(
                "kit",
                defineSchema({}),
                runtimeModules,
                kitOptions,
              ),
            ...options,
          },
        );
      const refused = yield* surfaceOn(kitLayer({})).pipe(refusalOf);
      const declared = yield* surfaceOn(
        kitLayer({ componentRuntimes: { kit: "node" } }),
      );
      // A kit that can pass its sources does.
      const fromSources = yield* surfaceOn(
        kitLayer({}, { sources: runtimeSources }),
      );
      expect(refused).toMatchObject({
        _tag: "ActionRuntimeUnknown",
        componentPath: "kit",
        module: "plainNode",
      });
      expect((refused as Error).message).toContain(
        'componentRuntimes: { "kit": "isolate" }',
      );
      expect(declared).toEqual(node);
      expect(fromSources).toEqual(node);
    }),
);

const pushCheckRef = {
  read: Ref.fromFunctionReference(pushCheckedRefs.read, "query"),
  write: Ref.fromFunctionReference(pushCheckedRefs.write, "mutation"),
};
const pushCheckForms = [
  {
    form: "schema and modules",
    layer: (
      graph: ReturnType<typeof pushChecked>,
      options: TestConfect.LayerOptions = {},
    ) =>
      TestConfect.layer(
        graph.schema,
        graph.convexSchema,
        graph.modules,
        options,
      ),
  },
  {
    form: "declared app",
    layer: (
      graph: ReturnType<typeof pushChecked>,
      options: TestConfect.LayerOptions = {},
    ) =>
      TestConfect.layer(
        {
          ...graph,
          components: {},
          httpMounts: [],
          packagedSources: undefined,
        },
        options,
      ),
  },
  {
    form: "app and registry",
    layer: (
      graph: ReturnType<typeof pushChecked>,
      options: TestConfect.LayerOptions = {},
    ) =>
      TestConfect.layer(
        App.make({ env }),
        { ...graph, components: {}, packagedSources: undefined },
        options,
      ),
  },
] as const;
const pushCheckTargets = ["convex-test", "kernel"] as const;
const pushCheckCases = Arr.flatMap(pushCheckForms, (form) =>
  Arr.map(pushCheckTargets, (target) => ({ ...form, target })),
);
const refusal = (check: string) =>
  PushCheck.PushRefused.make({ check, refusals: [pushCheckRefusal] });
// `body` on a fresh backend the layer builds, as its exit.
const builtThen = <A, E, LE, S extends DatabaseSchema.AnyWithProps>(
  layer: Layer.Layer<TestConfect.TestConfect<S>, LE>,
  body: (test: TestConfect.TestConfect<S>) => Effect.Effect<A, E>,
) =>
  Effect.exit(
    Effect.gen(function* () {
      const services = yield* Layer.build(layer);
      return yield* Effect.flatMap(TestConfect.TestConfect<S>(), body).pipe(
        Effect.provideContext(services),
      );
    }),
  );
const fetched = <S extends DatabaseSchema.AnyWithProps>(
  test: TestConfect.TestConfect<S>,
) =>
  Effect.flatMap(test.fetch("/hello"), (response) =>
    Effect.map(
      Effect.promise(() => response.text()),
      (body) => ({ status: response.status, body }),
    ),
  );

it.effect.each(pushCheckCases)(
  "on $target, the $form form refuses to build a source its push check refuses, so an HTTP-first request never reaches it",
  ({ layer, target }) =>
    Effect.gen(function* () {
      const graph = pushChecked({ refusals: [pushCheckRefusal] });
      const built = yield* builtThen(
        layer(graph, { target }),
        () => Effect.void,
      );
      diedWith(built, refusal("authz"));
      // The first call is HTTP, which runs no `exportArgs`.
      const served = yield* builtThen(layer(graph, { target }), fetched);
      diedWith(served, refusal("authz"));
      expect(graph.runs).toMatchObject({ check: 2, route: 0 });
    }),
);

it.effect.each(pushCheckCases)(
  "on $target, the $form form builds and serves a source its push check passes, running the check once per build before any call",
  ({ layer, target }) =>
    Effect.gen(function* () {
      const graph = pushChecked();
      const served = yield* builtThen(layer(graph, { target }), (test) =>
        Effect.gen(function* () {
          // Built, and nothing called yet.
          expect(graph.runs.check).toBe(1);
          return {
            http: yield* fetched(test),
            read: yield* test.query(pushCheckRef.read),
            write: yield* test.mutation(pushCheckRef.write),
          };
        }),
      );
      expect(served).toStrictEqual(
        Exit.succeed({
          http: { status: 200, body: "hi" },
          read: "read",
          write: "written",
        }),
      );
      // The analysis memo the calls read is apart from the build's run.
      expect(graph.runs.route).toBe(1);
    }),
);

it.effect.each(pushCheckTargets)(
  "on %s, a source with no registered push check builds and serves as before, running no check",
  (target) =>
    Effect.gen(function* () {
      const graph = pushChecked({ register: false });
      const served = yield* builtThen(
        TestConfect.layer(graph.schema, graph.convexSchema, graph.modules, {
          target,
        }),
        (test) => Effect.all([fetched(test), test.query(pushCheckRef.read)]),
      );
      expect(served).toStrictEqual(
        Exit.succeed([{ status: 200, body: "hi" }, "read"]),
      );
      expect(graph.runs).toMatchObject({ check: 0, route: 1 });
    }),
);

it.effect.each(pushCheckTargets)(
  "on %s, a component a kit registers runs its own push checks as the backend builds, and one the test registers later as it registers",
  (target) =>
    Effect.gen(function* () {
      const own = pushChecked({ register: false });
      const component = pushChecked({
        name: "component",
        refusals: [pushCheckRefusal],
      });
      const kit = TestConfect.layer(own.schema, own.convexSchema, own.modules, {
        target,
        register: (registerComponent) =>
          registerComponent(
            "guarded",
            component.convexSchema,
            component.modules,
          ),
      });
      const built = yield* builtThen(kit, () => Effect.void);
      diedWith(built, refusal("component"));
      const later = yield* builtThen(
        TestConfect.layer(own.schema, own.convexSchema, own.modules, {
          target,
        }),
        (test) =>
          test.registerComponent(
            "guarded",
            component.convexSchema,
            component.modules,
          ),
      );
      diedWith(later, refusal("component"));
      // A component whose checks pass registers and serves.
      const passing = pushChecked({ name: "component" });
      const served = yield* builtThen(
        TestConfect.layer(own.schema, own.convexSchema, own.modules, {
          target,
          register: (registerComponent) =>
            registerComponent("guarded", passing.convexSchema, passing.modules),
        }),
        () => Effect.void,
      );
      expect(served).toStrictEqual(Exit.void);
      expect(passing.runs.check).toBe(1);
    }),
);

it.effect.each(pushCheckTargets)(
  "on %s, refuses to build a backend whose schema has push checks none of its modules runs",
  (target) =>
    Effect.gen(function* () {
      const graph = pushChecked();
      const unguarded = {
        "_generated/server.ts": () => Promise.resolve({}),
        "tasks.ts": () =>
          Promise.resolve({
            read: queryGeneric({ args: {}, handler: () => "read" }),
          }),
      };
      const built = yield* builtThen(
        TestConfect.layer(graph.schema, graph.convexSchema, unguarded, {
          target,
        }),
        () => Effect.void,
      );
      diedWith(built, Preflight.NoPushEntry.make({ checks: ["authz"] }));
    }),
);

it.effect.each(pushCheckTargets)(
  'on %s, pushChecks: "skip" builds a refused source on purpose, which then serves HTTP and fails its first function call with the refusal',
  (target) =>
    Effect.gen(function* () {
      const graph = pushChecked({ refusals: [pushCheckRefusal] });
      const layer = TestConfect.layer(
        graph.schema,
        graph.convexSchema,
        graph.modules,
        { target, pushChecks: "skip" },
      );
      const served = yield* builtThen(layer, fetched);
      expect(served).toStrictEqual(Exit.succeed({ status: 200, body: "hi" }));
      expect(graph.runs).toMatchObject({ check: 0, route: 1 });
      const called = yield* builtThen(layer, (test) =>
        test.query(pushCheckRef.read),
      );
      assertIs(called, Exit.isFailure);
      expect(Cause.pretty(called.cause)).toContain(pushCheckRefusal);
      const own = pushChecked({ register: false });
      const later = yield* builtThen(
        TestConfect.layer(own.schema, own.convexSchema, own.modules, {
          target,
          pushChecks: "skip",
        }),
        (test) =>
          test.registerComponent("guarded", graph.convexSchema, graph.modules),
      );
      expect(later).toStrictEqual(Exit.void);
    }),
);

it.effect(
  "on convex-test, a module that fails to load fails the call that loads it, as before, and not the build",
  () =>
    Effect.gen(function* () {
      const graph = pushChecked();
      const modules = {
        ...graph.modules,
        "broken.ts": () => Promise.reject(new Error("broken at load")),
      };
      const served = yield* builtThen(
        TestConfect.layer(graph.schema, graph.convexSchema, modules),
        (test) =>
          Effect.gen(function* () {
            // The modules that loaded still ran their checks at the build.
            expect(graph.runs.check).toBe(1);
            return yield* test.query(pushCheckRef.read);
          }),
      );
      expect(served).toStrictEqual(Exit.succeed("read"));
    }),
);

it.effect(
  "on the kernel, a module that fails to load fails the first call with its failure, as before, and not the build",
  () =>
    Effect.gen(function* () {
      const graph = pushChecked({ refusals: [pushCheckRefusal] });
      const modules = {
        ...graph.modules,
        "broken.ts": () => Promise.reject(new Error("broken at load")),
      };
      // The kernel's open fails every call, so the build runs no check.
      const served = yield* builtThen(
        TestConfect.layer(graph.schema, graph.convexSchema, modules, {
          target: "kernel",
        }),
        (test) =>
          Effect.gen(function* () {
            expect(graph.runs.check).toBe(0);
            return yield* fetched(test);
          }),
      );
      assertIs(served, Exit.isFailure);
      expect(Cause.pretty(served.cause)).toContain("broken at load");
      expect(graph.runs.route).toBe(0);
    }),
);

// A host with no checks of its own and a component at `child`, mounted at
// `/child`, whose router is its only entry that runs its checks.
const mountedLayer = (
  component: ReturnType<typeof pushChecked>,
  target: TestConfect.Target,
  options: TestConfect.LayerOptions = {},
) => {
  const own = pushChecked({ register: false });
  return TestConfect.layer(own.schema, own.convexSchema, own.modules, {
    target,
    httpMounts: [{ componentPath: "child", httpPrefix: "/child" }],
    register: (registerComponent) =>
      registerComponent("child", component.convexSchema, component.modules),
    ...options,
  });
};
const fetchedAt = <S extends DatabaseSchema.AnyWithProps>(
  test: TestConfect.TestConfect<S>,
  path: string,
) =>
  Effect.flatMap(test.fetch(path), (response) =>
    Effect.map(
      Effect.promise(() => response.text()),
      (body) => ({ status: response.status, body }),
    ),
  );

it.effect.each(
  Arr.flatMap(pushCheckTargets, (target) =>
    Arr.map(["graph", "router"] as const, (registerIn) => ({
      target,
      registerIn,
    })),
  ),
)(
  "on $target, a mounted component whose router is its only checked entry, with its check registered from the $registerIn, refuses the build, so its first HTTP request never reaches it",
  ({ target, registerIn }) =>
    Effect.gen(function* () {
      const component = pushChecked({
        name: "child",
        refusals: [pushCheckRefusal],
        guarded: false,
        registerIn,
      });
      const built = yield* builtThen(mountedLayer(component, target), (test) =>
        fetchedAt(test, "/child/hello"),
      );
      diedWith(built, refusal("child"));
      expect(component.runs).toMatchObject({ check: 1, route: 0 });
    }),
);

it.effect.each(pushCheckTargets)(
  "on %s, a mounted component whose router passes builds its router at its mount's site URL, which its first HTTP request then serves",
  (target) =>
    Effect.gen(function* () {
      const component = pushChecked({
        name: "child",
        guarded: false,
        registerIn: "router",
      });
      const served = yield* builtThen(mountedLayer(component, target), (test) =>
        Effect.gen(function* () {
          // Built, and nothing called yet.
          expect(component.runs.check).toBe(1);
          return yield* fetchedAt(test, "/child/hello");
        }),
      );
      expect(served).toStrictEqual(Exit.succeed({ status: 200, body: "hi" }));
      expect(component.runs.route).toBe(1);
      expect(component.runs.siteUrl).toMatch(/\/child$/);
    }),
);

it.effect.each(pushCheckTargets)(
  'on %s, a mounted component with pushChecks: "skip" serves its refused router, whose request runs no check',
  (target) =>
    Effect.gen(function* () {
      const component = pushChecked({
        name: "child",
        refusals: [pushCheckRefusal],
        guarded: false,
      });
      const served = yield* builtThen(
        mountedLayer(component, target, { pushChecks: "skip" }),
        (test) => fetchedAt(test, "/child/hello"),
      );
      expect(served).toStrictEqual(Exit.succeed({ status: 200, body: "hi" }));
      expect(component.runs).toMatchObject({ check: 0, route: 1 });
    }),
);

it.effect.each(pushCheckTargets)(
  "on %s, a component registered with its database schema whose checks none of its functions or routers runs refuses the build, or its later registration, with NoPushEntry naming it",
  (target) =>
    Effect.gen(function* () {
      const own = pushChecked({ register: false });
      const component = pushChecked({
        name: "child",
        refusals: [pushCheckRefusal],
        guarded: false,
        router: false,
      });
      const unrun = Preflight.NoPushEntry.make({
        checks: ["child"],
        componentPath: "child",
      });
      for (const databaseSchema of [
        component.schema,
        () => Promise.resolve({ default: component.schema }),
      ]) {
        const built = yield* builtThen(
          TestConfect.layer(own.schema, own.convexSchema, own.modules, {
            target,
            register: (registerComponent) =>
              registerComponent(
                "child",
                component.convexSchema,
                component.modules,
                { databaseSchema },
              ),
          }),
          () => Effect.void,
        );
        diedWith(built, unrun);
      }
      const later = yield* builtThen(
        TestConfect.layer(own.schema, own.convexSchema, own.modules, {
          target,
        }),
        (test) =>
          test.registerComponent(
            "child",
            component.convexSchema,
            component.modules,
            { databaseSchema: component.schema },
          ),
      );
      diedWith(later, unrun);
      expect(component.runs.check).toBe(0);
      // A component whose entries run its checks passes with its schema given.
      const passing = pushChecked({ name: "child" });
      const served = yield* builtThen(
        TestConfect.layer(own.schema, own.convexSchema, own.modules, {
          target,
          register: (registerComponent) =>
            registerComponent("child", passing.convexSchema, passing.modules, {
              databaseSchema: passing.schema,
            }),
        }),
        () => Effect.void,
      );
      expect(served).toStrictEqual(Exit.void);
      expect(passing.runs.check).toBe(1);
    }),
);

it.effect.each(
  Arr.flatMap(pushCheckTargets, (target) =>
    Arr.map([true, false], (register) => ({ target, register })),
  ),
)(
  "on $target, with checks registered: $register, a module loader that throws or rejects before it is called fails no build",
  ({ target, register }) =>
    Effect.gen(function* () {
      const graph = pushChecked({ register });
      for (const broken of [
        (): Promise<unknown> => {
          throw new Error("thrown at load");
        },
        () => Promise.reject(new Error("rejected at load")),
      ]) {
        const built = yield* builtThen(
          TestConfect.layer(
            graph.schema,
            graph.convexSchema,
            { ...graph.modules, "broken.ts": broken },
            { target },
          ),
          () => Effect.void,
        );
        expect(built).toStrictEqual(Exit.void);
      }
    }),
);
