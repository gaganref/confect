import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as MutationCtx from "@confect/server/MutationCtx";
import { TestBackend, TestComponent } from "@confect/test";
import { Callback, FunctionSpec, Ref } from "@confect/core";
import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  actionGeneric,
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
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * A bounce code, an int64 as Convex stores it.
 */
const Code = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }),
);

class Bounced extends Schema.TaggedError<
  Bounced,
  { readonly brand: unique symbol }
>()("Bounced", { code: Code }) {}

class NotConfigured extends Schema.TaggedError<
  NotConfigured,
  { readonly brand: unique symbol }
>()("NotConfigured", {}) {}

class EmptyMessage extends Schema.TaggedError<
  EmptyMessage,
  { readonly brand: unique symbol }
>()("EmptyMessage", {}) {}

/**
 * The fixture component's one callback contract, as its `callbacks.ts` would
 * declare it. Its bounce carries an int64.
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

/**
 * An action that calls a handle it is given, which reaches the kernel without a
 * syscall, unlike a mutation's call.
 */
const relay = Ref.make(
  "mail",
  FunctionSpec.internalAction({
    name: "relay",
    args: () => ({ onEvent: Schema.String, message: Schema.String }),
    returns: () => Schema.String,
  }),
);

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

type Settings = { readonly fromName: string; readonly onEvent: string };

/**
 * The stored settings, or the declared `NotConfigured` before `init` ran.
 */
const configuredBy = (ctx: any): Promise<Settings> =>
  ctx.db
    .query("settings")
    .first()
    .then((settings: Settings | null) => {
      if (settings === null) throw new ConvexError({ _tag: "NotConfigured" });
      return settings;
    });

/**
 * What the host's answer to a call of the stored handle left the caller with:
 * the ticket it returned, or the declared error it failed with, decoded by the
 * handle the slot names. Anything else is the caller's failure.
 */
const answerOf = (
  call: Promise<unknown>,
): Promise<{ readonly delivered: string } | { readonly bounced: string }> => {
  const handle = subject.slots["mailer/onEvent"].handle;
  return call.then(
    (answer) => ({ delivered: (answer as { ticket: string }).ticket }),
    (error: unknown) => {
      const declared = Ref.isConvexError(error)
        ? Ref.decodeErrorOption(handle, error.data)
        : Option.none();
      if (Option.isNone(declared)) throw error;
      return {
        bounced: `bounced: ${declared.value._tag} (${typeof declared.value.code})`,
      };
    },
  );
};

/**
 * The `mailer` component: its own `init` stores the sender and the host's
 * handle, `send` calls the handle and records what the host answered, `later`
 * schedules it, and `relay` calls a handle from an action.
 */
const mailer = {
  "_generated/server.ts": () => Promise.resolve({}),
  "confectDeploy.ts": () =>
    Promise.resolve({
      steps: internalMutationGeneric({
        args: {},
        handler: () =>
          Promise.resolve([
            {
              componentPath: "audit",
              nested: false,
              init: { functionName: "init:run", args: { label: "audit" } },
            },
          ]),
      }),
    }),
  "install.ts": () =>
    Promise.resolve({
      init: internalMutationGeneric({
        args: { fromName: v.string(), onEvent: v.string() },
        handler: (ctx, args) =>
          ctx.db.insert("settings", args).then(() => null),
      }),
    }),
  "mail.ts": () =>
    Promise.resolve({
      send: mutationGeneric({
        args: { message: v.string() },
        handler: (ctx, { message }) => {
          if (message === "")
            return Promise.reject(new ConvexError({ _tag: "EmptyMessage" }));
          return configuredBy(ctx).then((settings) =>
            answerOf(
              ctx.runMutation(
                settings.onEvent as never,
                { fromName: settings.fromName, message } as never,
              ),
            ).then((answer) =>
              "delivered" in answer
                ? ctx.db
                    .insert("sent", { message, status: "delivered" })
                    .then(() => answer.delivered)
                : ctx.db
                    .insert("sent", { message, status: answer.bounced })
                    .then(() => null),
            ),
          );
        },
      }),
      later: mutationGeneric({
        args: { message: v.string() },
        handler: (ctx, { message }) =>
          configuredBy(ctx).then((settings) =>
            ctx.scheduler
              .runAfter(
                0,
                settings.onEvent as never,
                { fromName: settings.fromName, message } as never,
              )
              .then(() => null),
          ),
      }),
      relay: actionGeneric({
        args: { onEvent: v.string(), message: v.string() },
        handler: (ctx, { onEvent: stored, message }) =>
          answerOf(
            ctx.runMutation(
              stored as never,
              { fromName: "relay", message } as never,
            ),
          ).then((answer) =>
            "delivered" in answer ? "delivered" : answer.bounced,
          ),
      }),
      count: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("sent")
            .collect()
            .then((sent) => sent.length),
      }),
    }),
};

const audit = {
  "_generated/server.ts": () => Promise.resolve({}),
  "init.ts": () =>
    Promise.resolve({
      run: internalMutationGeneric({
        args: { label: v.string() },
        handler: (ctx, { label }) =>
          ctx.db.insert("log", { entry: `${label} ready` }).then(() => null),
      }),
    }),
  "state.ts": () =>
    Promise.resolve({
      log: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("log")
            .collect()
            .then((rows) => Arr.map(rows, ({ entry }) => entry)),
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
    mounts: [{ path: "audit", kit: "local", env: {}, required: [] }],
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
 * Run `body` with the services `layer` builds, in the test's scope.
 */
const within = <A, E, R, ROut, E2>(
  layer: Layer.Layer<ROut, E2>,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layer);
    return yield* body.pipe(Effect.provideContext(services));
  });

const opened =
  (options: Parameters<typeof subject.layer>[0]) =>
  <A, E, R>(body: Effect.Effect<A, E, R>) =>
    within(subject.layer(options), body);

/**
 * The command that arrives at position `at` of the session.
 */
const arrival = (at: number) =>
  Effect.gen(function* () {
    const engine = yield* TestComponent.Callbacks;
    return yield* engine.arrival(at);
  });

describe("TestComponent.layer", () => {
  it.effect(
    "runs the subject's own init with its install args, then each mount's, then the seed, which reads both",
    () =>
      Effect.gen(function* () {
        const session = yield* TestBackend.Session;
        // The subject's own init is the root step of the shared traversal, so
        // it runs before its mounts', as a parent's push runs it.
        expect(session.initialized).toEqual(["", "audit"]);
        expect(session.standing).toEqual({ audit: [] });
        const engine = yield* TestComponent.Callbacks;
        const image = yield* engine.image;
        expect(image).toEqual({
          settings: [stored],
          seen: [{ entry: "seed saw Ada and [audit ready]" }],
        });
      }).pipe(
        opened({
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
            const entry = `seed saw ${sender["fromName"] as string} and [${Arr.join(log, ",")}]`;
            yield* Effect.promise(() => ctx.db.insert("seen", { entry }));
          }),
        }),
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
        const pending = yield* TestComponent.commands(subject);
        expect(pending).toEqual([
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
        const before = yield* test.query(functions["mail:count"]);
        expect(before).toBe(0);
        yield* TestComponent.answer(command, "returned");
        const ticket = yield* Fiber.join(sending);
        assert(typeof ticket === "string");
        const after = yield* test.query(functions["mail:count"]);
        expect(after).toBe(1);
        const left = yield* TestComponent.commands(subject);
        expect(left).toEqual([]);
        const again = yield* Effect.gen(function* () {
          const other = yield* runtime;
          const fiber = yield* Effect.forkChild(
            other.mutation(functions["mail:send"], { message: "hello" }),
          );
          const next = yield* arrival(0);
          yield* TestComponent.answer(next, "returned");
          return yield* Fiber.join(fiber);
        }).pipe(opened({ config, install }));
        expect(again).toBe(ticket);
      }).pipe(opened({ config, install })),
  );

  it.effect(
    "answers a mutation's call with a declared error, so its int64 field reaches the component decoded",
    () =>
      Effect.gen(function* () {
        const test = yield* runtime;
        const sending = yield* Effect.forkChild(
          test.mutation(functions["mail:send"], { message: "hello" }),
        );
        const command = yield* arrival(0);
        yield* TestComponent.answer(command, "Bounced");
        const sent = yield* Fiber.join(sending);
        expect(sent).toBeNull();
        const engine = yield* TestComponent.Callbacks;
        const image = yield* engine.image;
        expect(image).toMatchObject({
          sent: [{ message: "hello", status: "bounced: Bounced (bigint)" }],
        });
      }).pipe(opened({ config, install })),
  );

  it.effect(
    "answers an action's call with a declared error as a Convex value, so its int64 field arrives decoded",
    () =>
      Effect.gen(function* () {
        const test = yield* runtime;
        const relaying = yield* Effect.forkChild(
          test.action(relay, { onEvent: stored.onEvent, message: "hello" }),
        );
        const command = yield* arrival(0);
        yield* TestComponent.answer(command, "Bounced");
        const relayed = yield* Fiber.join(relaying);
        expect(relayed).toBe("bounced: Bounced (bigint)");
      }).pipe(opened({ config, install })),
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
        const undeclared = yield* Effect.flip(
          // @ts-expect-error The contract declares no `Timeout`.
          TestComponent.answer(command, "Timeout"),
        );
        expect(undeclared).toMatchObject({
          _tag: "UndeclaredOutcome",
          message:
            "The callback slot mailer/onEvent has no outcome Timeout; its contract allows returned, Bounced.",
        });
        yield* TestComponent.answer(command, "returned");
        yield* Fiber.join(sending);
        const stale = yield* Effect.flip(
          TestComponent.answer(command, "returned"),
        );
        expect(stale).toMatchObject({ _tag: "StaleCommand", id: command.id });
      }).pipe(opened({ config, install })),
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
        const left = yield* TestComponent.commands(subject);
        expect(left).toEqual([]);
      }).pipe(opened({ config, install })),
  );

  it.effect("gives the component no caller identity", () =>
    Effect.gen(function* () {
      const test = yield* runtime;
      expect("withIdentity" in test).toBe(false);
      // @ts-expect-error A component runtime has no `withIdentity`.
      expect(test.withIdentity).toBeUndefined();
    }).pipe(opened({ config, install })),
  );
});

class First extends Schema.TaggedError<
  First,
  { readonly brand: unique symbol }
>()("First", {}) {}
class Second extends Schema.TaggedError<
  Second,
  { readonly brand: unique symbol }
>()("Second", {}) {}
class Third extends Schema.TaggedError<
  Third,
  { readonly brand: unique symbol }
>()("Third", {}) {}

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
    expect(Arr.map(exported, ({ owes }) => owes)).toEqual([
      { kind: "export", ref: "mail:count" },
      { kind: "export", ref: "mail:later" },
      { kind: "export", ref: "mail:send" },
    ]);
    expect(Arr.map(answered, ({ name, owes }) => [name, owes])).toEqual([
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
        const failed = yield* Effect.flip(
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
        );
        expect(failed).toMatchObject({
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
