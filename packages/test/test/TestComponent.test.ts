// oxlint-disable effecttsgo/async-function -- The fixtures are plain Convex functions, which are async as product code is.
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as MutationCtx from "@confect/server/MutationCtx";
import { TestBackend, TestComponent } from "@confect/test";
import { Callback, FunctionSpec, Ref } from "@confect/core";
import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  componentsGeneric,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericDataModel,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

/**
 * A bounce code, an int64 as Convex stores it.
 */
const Code = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }),
);

class Bounced extends Schema.TaggedError<Bounced>()("Bounced", {
  code: Code,
}) {}

class NotConfigured extends Schema.TaggedError<NotConfigured>()(
  "NotConfigured",
  {},
) {}

class EmptyMessage extends Schema.TaggedError<EmptyMessage>()(
  "EmptyMessage",
  {},
) {}

/**
 * The fixture component's one callback contract, as its `callbacks.ts` would
 * declare it. Its bounce carries a bigint, which crosses as Convex JSON.
 */
const OnEvent = Callback.mutation("mailer/onEvent", {
  args: () => ({ fromName: Schema.String, message: Schema.String }),
  returns: () => Schema.Struct({ ticket: Schema.String }),
  error: () => Bounced,
});

const send = FunctionSpec.publicMutation({
  name: "send",
  args: () => ({ message: Schema.String }),
  returns: () => Schema.NullOr(Schema.String),
  error: () => Schema.Union([NotConfigured, EmptyMessage]),
});
const later = FunctionSpec.publicMutation({
  name: "later",
  args: () => ({ message: Schema.String }),
  returns: () => Schema.Null,
});
const count = FunctionSpec.publicQuery({
  name: "count",
  returns: () => Schema.Finite,
});
const init = FunctionSpec.internalMutation({
  name: "init",
  args: () => ({ fromName: Schema.String, onEvent: Callback.handle(OnEvent) }),
  returns: () => Schema.Null,
});

const functions = {
  "mail:count": Ref.make("mail", count),
  "mail:later": Ref.make("mail", later),
  "mail:send": Ref.make("mail", send),
};

const components = componentsGeneric() as unknown as {
  readonly audit: {
    readonly state: {
      readonly log: FunctionReference<"query", "internal", {}, Array<string>>;
    };
  };
};

const onEvent = Callback.handle(OnEvent);

const configuredBy = async (ctx: any) => {
  const settings = await ctx.db.query("settings").first();
  if (settings === null) throw new ConvexError({ _tag: "NotConfigured" });
  return settings as { fromName: string; onEvent: string };
};

/**
 * The `mailer` component: its own `init` stores the sender and the host's
 * handle, `send` calls the handle and records what the host answered, and
 * `later` schedules it.
 */
const mailer = {
  "_generated/server.ts": () => Promise.resolve({}),
  "confectDeploy.ts": () =>
    Promise.resolve({
      steps: internalMutationGeneric({
        args: {},
        handler: async () => [
          {
            componentPath: "audit",
            nested: false,
            init: { functionName: "init:run", args: { label: "audit" } },
          },
        ],
      }),
    }),
  "install.ts": () =>
    Promise.resolve({
      init: internalMutationGeneric({
        args: { fromName: v.string(), onEvent: v.string() },
        handler: async (ctx, args) => {
          await ctx.db.insert("settings", args);
          return null;
        },
      }),
    }),
  "mail.ts": () =>
    Promise.resolve({
      send: mutationGeneric({
        args: { message: v.string() },
        handler: async (ctx, { message }) => {
          if (message === "") throw new ConvexError({ _tag: "EmptyMessage" });
          const settings = await configuredBy(ctx);
          const handle = Schema.decodeSync(onEvent)(settings.onEvent);
          try {
            const answer = await ctx.runMutation(
              handle.convexFunctionName as never,
              { fromName: settings.fromName, message } as never,
            );
            await ctx.db.insert("sent", { message, status: "delivered" });
            return (answer as { ticket: string }).ticket;
          } catch (error) {
            const declared = Ref.isConvexError(error)
              ? Ref.decodeErrorOption(handle, error.data)
              : undefined;
            if (declared?._tag !== "Some") throw error;
            await ctx.db.insert("sent", {
              message,
              status: `bounced: ${declared.value._tag} (${typeof declared.value.code})`,
            });
            return null;
          }
        },
      }),
      later: mutationGeneric({
        args: { message: v.string() },
        handler: async (ctx, { message }) => {
          const settings = await configuredBy(ctx);
          await ctx.scheduler.runAfter(
            0,
            settings.onEvent as never,
            { fromName: settings.fromName, message } as never,
          );
          return null;
        },
      }),
      count: queryGeneric({
        args: {},
        handler: async (ctx) => (await ctx.db.query("sent").collect()).length,
      }),
    }),
};

const audit = {
  "_generated/server.ts": () => Promise.resolve({}),
  "init.ts": () =>
    Promise.resolve({
      run: internalMutationGeneric({
        args: { label: v.string() },
        handler: async (ctx, { label }) => {
          await ctx.db.insert("log", { entry: `${label} ready` });
        },
      }),
    }),
  "state.ts": () =>
    Promise.resolve({
      log: queryGeneric({
        args: {},
        handler: async (ctx) =>
          (await ctx.db.query("log").collect()).map(({ entry }) => entry),
      }),
    }),
};

const schema = DatabaseSchema.make({});

const settings = [
  { name: "MAILER_REGION", owner: "mailer", optional: false },
] as const;

const subject = TestComponent.make(
  {
    schema,
    convexSchema: defineSchema({
      settings: defineTable({ fromName: v.string(), onEvent: v.string() }),
      sent: defineTable({ message: v.string(), status: v.string() }),
      seen: defineTable({ entry: v.string() }),
    }) as never,
    httpMounts: [],
    modules: mailer,
    components: {
      audit: {
        schema: defineSchema({ log: defineTable({ entry: v.string() }) }),
        modules: audit,
      },
    },
  },
  {
    refs: { public: { mail: functions } },
    functions,
    ports: {},
    slots: { "mailer/onEvent": TestComponent.slot(OnEvent) },
    init: Ref.make("install", init),
    laws: [
      { law: "decodes", table: "sent" },
      { law: "idScope", table: "sent" },
    ],
    obligations: [
      { kind: "export", ref: "mail:count" },
      { kind: "export", ref: "mail:later" },
      { kind: "export", ref: "mail:send" },
      { kind: "laws" },
      { kind: "callback", slot: "mailer/onEvent" },
    ],
    mounts: [{ path: "audit", kit: "local" }],
    settings,
  },
);

const config = { MAILER_REGION: "eu" };
const install = {
  fromName: "Ada",
  onEvent: subject.slots["mailer/onEvent"].handle,
};
const stored = {
  fromName: "Ada",
  onEvent: "function://~sink;mailer/onEvent",
};

const raw = MutationCtx.MutationCtx<GenericDataModel>();
const runtime = TestComponent.ComponentRuntime<typeof schema>();

/**
 * The command that arrives at position `at` of the session.
 */
const arrival = (at: number) =>
  Effect.gen(function* () {
    return yield* (yield* TestComponent.Callbacks).arrival(at);
  });

describe("TestComponent.layer", () => {
  it.effect(
    "runs the subject's own init with its install args and each mount's before the seed, which reads both",
    () =>
      Effect.gen(function* () {
        const session = yield* TestBackend.Session;
        // The shared traversal orders the subject's init against its mounts'.
        expect([...session.initialized].sort()).toEqual(["", "audit"]);
        expect(session.standing).toEqual({ audit: [] });
        const engine = yield* TestComponent.Callbacks;
        expect(yield* engine.image).toEqual({
          settings: [stored],
          seen: [{ entry: "seed saw Ada and [audit ready]" }],
        });
      }).pipe(
        Effect.provide(
          subject.layer({
            config,
            install,
            seed: Effect.gen(function* () {
              const ctx = yield* raw;
              const log = yield* Effect.promise(() =>
                ctx.runQuery(components.audit.state.log, {}),
              );
              const sender = yield* Effect.promise(() =>
                ctx.db.query("settings").first(),
              );
              if (log.length === 0 || sender === null)
                return yield* Effect.die(new Error("an init has not run"));
              yield* Effect.promise(() =>
                ctx.db.insert("seen", {
                  entry: `seed saw ${sender["fromName"] as string} and [${log.join(",")}]`,
                }),
              );
            }),
          }),
        ),
      ),
  );

  it.effect(
    "holds a call to a slot as a pending command while another call runs, and the call returns once answered",
    () =>
      Effect.gen(function* () {
        const test = yield* runtime;
        const sending = yield* Effect.forkChild(
          test.mutation(functions["mail:send"], { message: "hello" }),
        );
        const command = yield* arrival(0);
        expect(yield* TestComponent.commands(subject)).toEqual([
          {
            id: command.id,
            kind: "callback",
            slot: "mailer/onEvent",
            input: { fromName: "Ada", message: "hello" },
            outcomes: ["returned", "Bounced"],
            componentPath: "",
            functionName: "mail:send",
          },
        ]);
        // The held send has not committed, so a call between sees no delivery.
        expect(yield* test.query(functions["mail:count"])).toBe(0);
        yield* TestComponent.answer(command, "returned");
        const ticket = yield* Fiber.join(sending);
        assert(typeof ticket === "string");
        expect(yield* test.query(functions["mail:count"])).toBe(1);
        expect(yield* TestComponent.commands(subject)).toEqual([]);
        const again = yield* Effect.provide(
          Effect.gen(function* () {
            const other = yield* runtime;
            const fiber = yield* Effect.forkChild(
              other.mutation(functions["mail:send"], { message: "hello" }),
            );
            yield* TestComponent.answer(yield* arrival(0), "returned");
            return yield* Fiber.join(fiber);
          }),
          subject.layer({ config, install }),
        );
        expect(again).toBe(ticket);
      }).pipe(Effect.provide(subject.layer({ config, install }))),
  );

  it.effect(
    "answers with a declared error as Convex JSON, so a bigint field reaches the component decoded",
    () =>
      Effect.gen(function* () {
        const test = yield* runtime;
        const sending = yield* Effect.forkChild(
          test.mutation(functions["mail:send"], { message: "hello" }),
        );
        yield* TestComponent.answer(yield* arrival(0), "Bounced");
        expect(yield* Fiber.join(sending)).toBeNull();
        expect(yield* (yield* TestComponent.Callbacks).image).toMatchObject({
          sent: [{ message: "hello", status: "bounced: Bounced (bigint)" }],
        });
      }).pipe(Effect.provide(subject.layer({ config, install }))),
  );

  it.effect(
    "refuses an answer to a settled command, and an outcome its slot does not declare",
    () =>
      Effect.gen(function* () {
        const test = yield* runtime;
        const sending = yield* Effect.forkChild(
          test.mutation(functions["mail:send"], { message: "hello" }),
        );
        yield* arrival(0);
        const [command] = yield* TestComponent.commands(subject);
        assert(command !== undefined);
        expect(
          yield* Effect.flip(
            // @ts-expect-error The contract declares no `Timeout`.
            TestComponent.answer(command, "Timeout"),
          ),
        ).toMatchObject({
          _tag: "UndeclaredOutcome",
          message:
            "The callback slot mailer/onEvent has no outcome Timeout; its contract allows returned, Bounced.",
        });
        yield* TestComponent.answer(command, "returned");
        yield* Fiber.join(sending);
        expect(
          yield* Effect.flip(TestComponent.answer(command, "returned")),
        ).toMatchObject({ _tag: "StaleCommand", id: command.id });
      }).pipe(Effect.provide(subject.layer({ config, install }))),
  );

  it.effect(
    "holds a scheduled call to a stored handle as a command once its job comes due",
    () =>
      Effect.gen(function* () {
        const test = yield* runtime;
        yield* test.mutation(functions["mail:later"], { message: "soon" });
        const draining = yield* Effect.forkChild(
          test.finishAllScheduledFunctions(() => undefined),
        );
        const command = yield* arrival(0);
        expect(command).toMatchObject({
          slot: "mailer/onEvent",
          input: { fromName: "Ada", message: "soon" },
          componentPath: undefined,
          functionName: undefined,
        });
        yield* TestComponent.answer(command, "returned");
        yield* Fiber.join(draining);
        expect(yield* TestComponent.commands(subject)).toEqual([]);
      }).pipe(Effect.provide(subject.layer({ config, install }))),
  );

  it.effect("gives the component no caller identity", () =>
    Effect.gen(function* () {
      const test = yield* runtime;
      expect("withIdentity" in test).toBe(false);
      // @ts-expect-error A component runtime has no `withIdentity`.
      expect(test.withIdentity).toBeUndefined();
    }).pipe(Effect.provide(subject.layer({ config, install }))),
  );
});

class First extends Schema.TaggedError<First>()("First", {}) {}
class Second extends Schema.TaggedError<Second>()("Second", {}) {}
class Third extends Schema.TaggedError<Third>()("Third", {}) {}

describe("TestComponent.slot", () => {
  it("keeps every tag of a nested union of errors", () => {
    const nested = Callback.mutation("mailer/nested", {
      returns: () => Schema.Null,
      error: () => Schema.Union([First, Schema.Union([Second, Third])]),
    });
    expect(TestComponent.slot(nested).outcomes).toEqual([
      "returned",
      "First",
      "Second",
      "Third",
    ]);
  });

  it("keeps every tag of a suspended union of errors", () => {
    const suspended = Callback.mutation("mailer/suspended", {
      returns: () => Schema.Null,
      error: () => Schema.suspend(() => Schema.Union([First, Second])),
    });
    expect(TestComponent.slot(suspended).outcomes).toEqual([
      "returned",
      "First",
      "Second",
    ]);
  });
});

describe("TestComponent.exports and callbacks", () => {
  const exported = TestComponent.exports(subject, {
    "mail:count": [
      { name: "empty", returns: 0, postimage: { settings: [stored] } },
    ],
    "mail:later": [
      {
        name: "schedules",
        args: { message: "x" },
        returns: null,
        postimage: { settings: [stored] },
      },
    ],
    "mail:send": [
      {
        name: "an empty message",
        args: { message: "" },
        fails: "EmptyMessage",
      },
    ],
  });
  const answered = TestComponent.callbacks(subject, {
    "mailer/onEvent": {
      returned: {
        name: "delivers",
        call: "mail:send",
        args: { message: "hi" },
        postimage: {
          settings: [stored],
          sent: [{ message: "hi", status: "delivered" }],
        },
      },
      Bounced: {
        name: "records the bounce",
        call: "mail:send",
        args: { message: "hi" },
        postimage: {
          settings: [stored],
          sent: [{ message: "hi", status: "bounced: Bounced (bigint)" }],
        },
      },
    },
  });

  it("pays one obligation per case", () => {
    expect(exported.map(({ owes }) => owes)).toEqual([
      { kind: "export", ref: "mail:count" },
      { kind: "export", ref: "mail:later" },
      { kind: "export", ref: "mail:send" },
    ]);
    expect(answered.map(({ name, owes }) => [name, owes])).toEqual([
      [
        "mailer/onEvent returned delivers",
        { kind: "callback", slot: "mailer/onEvent" },
      ],
      [
        "mailer/onEvent Bounced records the bounce",
        { kind: "callback", slot: "mailer/onEvent" },
      ],
    ]);
  });

  it.effect(
    "runs every case on a fresh session, after the subject's own init",
    () =>
      Effect.forEach([...exported, ...answered], (each) =>
        each.run({ config, install }),
      ),
  );

  it.effect("fails a case whose postimage differs", () =>
    Effect.gen(function* () {
      const [wrong] = TestComponent.callbacks(subject, {
        "mailer/onEvent": {
          returned: {
            name: "claims nothing changed",
            call: "mail:send",
            args: { message: "hi" },
            postimage: { settings: [stored] },
          },
          Bounced: { name: "unused", call: "mail:count", postimage: {} },
        },
      });
      const error = yield* Effect.flip(wrong!.run({ config, install }));
      expect(error).toMatchObject({
        _tag: "CaseFailed",
        case: "mailer/onEvent returned claims nothing changed",
      });
      expect(error.reason).toContain('"status":"delivered"');
    }),
  );

  it.effect(
    "fails a case whose call never reaches the slot, even when the seed called it",
    () =>
      Effect.gen(function* () {
        const [, wrong] = TestComponent.callbacks(subject, {
          "mailer/onEvent": {
            returned: { name: "unused", call: "mail:count", postimage: {} },
            Bounced: { name: "counts", call: "mail:count", postimage: {} },
          },
        });
        expect(
          yield* Effect.flip(
            wrong!.run({
              config,
              install,
              seed: Effect.gen(function* () {
                const ctx = yield* raw;
                yield* Effect.promise(() =>
                  ctx.runMutation(
                    stored.onEvent as unknown as FunctionReference<"mutation">,
                    { fromName: "seed", message: "seeded" },
                  ),
                );
              }),
            }),
          ),
        ).toMatchObject({
          reason: "mail:count never called the slot mailer/onEvent",
        });
      }),
  );

  it("hands the laws to the testing door as a typed slot", () => {
    const owed = TestComponent.laws(subject, Effect.void);
    expect(owed.owes).toEqual({ kind: "laws" });
    expect(owed.laws).toBe(subject.laws);
  });
});

describe("TestComponent's types", () => {
  it("refuses a missing function or outcome, and missing install args", () => {
    // @ts-expect-error `mail:send` and `mail:later` have no rows.
    TestComponent.exports(subject, {
      "mail:count": [{ name: "empty", returns: 0, postimage: {} }],
    });
    TestComponent.exports(subject, {
      "mail:count": [{ name: "empty", returns: 0, postimage: {} }],
      "mail:later": [
        { name: "x", args: { message: "x" }, returns: null, postimage: {} },
      ],
      // @ts-expect-error `send` declares no `Bounced`.
      "mail:send": [{ name: "x", args: { message: "x" }, fails: "Bounced" }],
    });
    TestComponent.callbacks(subject, {
      // @ts-expect-error The slot's `Bounced` outcome has no case.
      "mailer/onEvent": {
        returned: { name: "x", call: "mail:count", postimage: {} },
      },
    });
    // @ts-expect-error The slot has no case at all.
    TestComponent.callbacks(subject, {});
    // @ts-expect-error The subject's `init` takes install args.
    subject.layer({ config });
  });

  it("owes no access or realm proof", () => {
    expectTypeOf<TestBackend.Owed<typeof subject>>().toEqualTypeOf<
      | { readonly kind: "export"; readonly ref: "mail:count" }
      | { readonly kind: "export"; readonly ref: "mail:later" }
      | { readonly kind: "export"; readonly ref: "mail:send" }
      | { readonly kind: "laws" }
      | { readonly kind: "callback"; readonly slot: "mailer/onEvent" }
    >();
    // @ts-expect-error A component owes no realm proof.
    const realm: TestComponent.ComponentObligation = { kind: "realm" };
    const access: TestComponent.ComponentObligation = {
      // @ts-expect-error A component owes no access proof.
      kind: "access",
      group: "mail",
    };
    expect([realm, access]).toHaveLength(2);
    const realmCheck = (
      backend: TestBackend.GeneratedBackend<unknown, {}, {}>,
    ) => backend.obligations;
    // @ts-expect-error A realm check takes an app's subject, not a component's.
    realmCheck(subject);
  });
});
