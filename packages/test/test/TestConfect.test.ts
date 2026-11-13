// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of fresh Node processes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TestConfect } from "@confect/test";
import { DatabaseSchema, MutationCtx } from "@confect/server";
import * as Layer from "effect/Layer";
import { beforeEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { App, Mount, Table } from "@confect/core";
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
import * as Json from "../src/internal/Json";
import { assertIs } from "./internal/assertIs";

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

it.effect.each([
  {
    form: "declared app",
    layer: (options: TestConfect.TargetOptions) =>
      TestConfect.layer(registry, options),
  },
  {
    form: "app and registry",
    layer: (options: TestConfect.TargetOptions) =>
      TestConfect.layer(app, registry, options),
  },
  {
    form: "schema and modules",
    layer: (options: TestConfect.TargetOptions) =>
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
      const services12 = yield* Layer.build(layer({ target: "kernel" }));
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
