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
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

class Bounced extends Schema.TaggedError<Bounced>()("Bounced", {
  reason: Schema.String,
}) {}

class NotConfigured extends Schema.TaggedError<NotConfigured>()(
  "NotConfigured",
  {},
) {}

/**
 * The fixture component's one callback contract, as its `callbacks.ts` would
 * declare it.
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
  error: () => NotConfigured,
});
const count = FunctionSpec.publicQuery({
  name: "count",
  returns: () => Schema.Finite,
});

const functions = {
  "mail:send": Ref.make("mail", send),
  "mail:count": Ref.make("mail", count),
};

const components = componentsGeneric() as unknown as {
  readonly audit: {
    readonly state: {
      readonly log: FunctionReference<"query", "internal", {}, Array<string>>;
    };
  };
};

const onEvent = Callback.handle(OnEvent);

/**
 * `send` calls the stored handle and records what the host answered: a
 * delivery, or a bounce decoded as the contract's declared error.
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
  "mail.ts": () =>
    Promise.resolve({
      send: mutationGeneric({
        args: { message: v.string() },
        handler: async (ctx, { message }) => {
          const settings = await ctx.db.query("settings").first();
          if (settings === null)
            throw new ConvexError({ _tag: "NotConfigured" });
          const handle = Schema.decodeSync(onEvent)(settings["onEvent"]);
          try {
            const answer = await ctx.runMutation(
              handle.convexFunctionName as never,
              { fromName: settings["fromName"], message } as never,
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
              status: `bounced: ${declared.value._tag}`,
            });
            return null;
          }
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
    laws: [
      { law: "decodes", table: "sent" },
      { law: "idScope", table: "sent" },
    ],
    obligations: [
      { kind: "export", ref: "mail:count" },
      { kind: "export", ref: "mail:send" },
      { kind: "laws" },
      { kind: "callback", slot: "mailer/onEvent" },
    ],
    mounts: [{ path: "audit", kit: "local" }],
    settings,
  },
);

const config = { MAILER_REGION: "eu" };

const raw = MutationCtx.MutationCtx<GenericDataModel>();

/**
 * Store the slot's sink handle where the component keeps its handle.
 */
const configured = Effect.gen(function* () {
  const ctx = yield* raw;
  const handle = yield* Schema.encodeEffect(onEvent)(
    subject.slots["mailer/onEvent"].handle,
  ).pipe(Effect.orDie);
  yield* Effect.promise(() =>
    ctx.db.insert("settings", { fromName: "Ada", onEvent: handle }),
  );
});

const runtime = TestComponent.ComponentRuntime<typeof schema>();

describe("TestComponent.layer", () => {
  it.effect("runs each mount's init before the seed, which reads it", () =>
    Effect.gen(function* () {
      const session = yield* TestBackend.Session;
      expect(session.initialized).toEqual(["audit"]);
      expect(session.standing).toEqual({ audit: [] });
      const engine = yield* TestComponent.Callbacks;
      expect(yield* engine.image).toEqual({
        seen: [{ entry: "seed saw [audit ready]" }],
      });
    }).pipe(
      Effect.provide(
        subject.layer({
          config,
          seed: Effect.gen(function* () {
            const ctx = yield* raw;
            const log = yield* Effect.promise(() =>
              ctx.runQuery(components.audit.state.log, {}),
            );
            if (log.length === 0)
              return yield* Effect.die(new Error("init has not run"));
            yield* Effect.promise(() =>
              ctx.db.insert("seen", { entry: `seed saw [${log.join(",")}]` }),
            );
          }),
        }),
      ),
    ),
  );

  it.effect(
    "holds a call to a slot as a callback command and answers it returned, with a value drawn from the contract's codec",
    () =>
      Effect.gen(function* () {
        const test = yield* runtime;
        const ticket = yield* test.mutation(functions["mail:send"], {
          message: "hello",
        });
        assert(typeof ticket === "string");
        expect(yield* TestComponent.held).toEqual([
          {
            kind: "callback",
            slot: "mailer/onEvent",
            args: { fromName: "Ada", message: "hello" },
            outcome: "returned",
          },
        ]);
        const again = yield* Effect.provide(
          Effect.flatMap(runtime, (other) =>
            other.mutation(functions["mail:send"], { message: "hello" }),
          ),
          subject.layer({ config, seed: configured }),
        );
        expect(again).toBe(ticket);
      }).pipe(Effect.provide(subject.layer({ config, seed: configured }))),
  );

  it.effect(
    "answers a call with a declared error the component decodes by its tag",
    () =>
      Effect.gen(function* () {
        const test = yield* runtime;
        yield* TestComponent.answer(subject, "mailer/onEvent", "Bounced");
        expect(
          yield* test.mutation(functions["mail:send"], { message: "hello" }),
        ).toBeNull();
        expect((yield* TestComponent.held)[0]?.outcome).toBe("Bounced");
        expect(yield* (yield* TestComponent.Callbacks).image).toMatchObject({
          sent: [{ message: "hello", status: "bounced: Bounced" }],
        });
      }).pipe(Effect.provide(subject.layer({ config, seed: configured }))),
  );

  it.effect("refuses an outcome the slot's contract does not declare", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        // @ts-expect-error The contract declares no `Timeout`.
        TestComponent.answer(subject, "mailer/onEvent", "Timeout"),
      );
      assert(Exit.isFailure(exit));
      expect(String(exit.cause)).toContain(
        "has no outcome Timeout; its contract allows returned, Bounced",
      );
    }).pipe(Effect.provide(subject.layer({ config }))),
  );

  it.effect("gives the component no caller identity", () =>
    Effect.gen(function* () {
      const test = yield* runtime;
      expect("withIdentity" in test).toBe(false);
      // @ts-expect-error A component runtime has no `withIdentity`.
      expect(test.withIdentity).toBeUndefined();
    }).pipe(Effect.provide(subject.layer({ config }))),
  );
});

describe("TestComponent.exports and callbacks", () => {
  const exported = TestComponent.exports(subject, {
    "mail:count": [{ name: "empty", returns: 0, postimage: {} }],
    "mail:send": [
      { name: "unconfigured", args: { message: "hi" }, fails: "NotConfigured" },
    ],
  });
  const answered = TestComponent.callbacks(subject, {
    "mailer/onEvent": {
      returned: {
        name: "delivers",
        call: "mail:send",
        args: { message: "hi" },
        postimage: {
          settings: [
            { fromName: "Ada", onEvent: "function://~sink;mailer/onEvent" },
          ],
          sent: [{ message: "hi", status: "delivered" }],
        },
      },
      Bounced: {
        name: "records the bounce",
        call: "mail:send",
        args: { message: "hi" },
        postimage: {
          settings: [
            { fromName: "Ada", onEvent: "function://~sink;mailer/onEvent" },
          ],
          sent: [{ message: "hi", status: "bounced: Bounced" }],
        },
      },
    },
  });

  it("pays one obligation per case", () => {
    expect(exported.map(({ owes }) => owes)).toEqual([
      { kind: "export", ref: "mail:count" },
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

  it.effect("runs every case on a fresh session", () =>
    Effect.gen(function* () {
      yield* Effect.forEach(exported, (each) => each.run({ config }));
      yield* Effect.forEach(answered, (each) =>
        each.run({ config, seed: configured }),
      );
    }),
  );

  it.effect("fails a case whose postimage differs", () =>
    Effect.gen(function* () {
      const [wrong] = TestComponent.callbacks(subject, {
        "mailer/onEvent": {
          returned: {
            name: "claims nothing changed",
            call: "mail:send",
            args: { message: "hi" },
            postimage: {},
          },
          Bounced: {
            name: "unused",
            call: "mail:count",
            postimage: {},
          },
        },
      });
      const error = yield* Effect.flip(
        wrong!.run({ config, seed: configured }),
      );
      expect(error).toMatchObject({
        _tag: "CaseFailed",
        case: "mailer/onEvent returned claims nothing changed",
      });
      expect(error.reason).toContain('"status":"delivered"');
    }),
  );

  it.effect("fails a case whose call never reaches the slot", () =>
    Effect.gen(function* () {
      const [, wrong] = TestComponent.callbacks(subject, {
        "mailer/onEvent": {
          returned: { name: "unused", call: "mail:count", postimage: {} },
          Bounced: { name: "counts", call: "mail:count", postimage: {} },
        },
      });
      expect(yield* Effect.flip(wrong!.run({ config }))).toMatchObject({
        reason: "mail:count never called the slot mailer/onEvent",
      });
    }),
  );

  it("hands the laws to the testing door as a typed slot", () => {
    const owed = TestComponent.laws(subject, configured);
    expect(owed.owes).toEqual({ kind: "laws" });
    expect(owed.laws).toBe(subject.laws);
  });
});

describe("TestComponent's types", () => {
  it("refuses a missing function or outcome", () => {
    // @ts-expect-error `mail:send` has no row.
    TestComponent.exports(subject, {
      "mail:count": [{ name: "empty", returns: 0, postimage: {} }],
    });
    TestComponent.exports(subject, {
      "mail:count": [{ name: "empty", returns: 0, postimage: {} }],
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
  });

  it("owes no access or realm proof", () => {
    expectTypeOf<TestBackend.Owed<typeof subject>>().toEqualTypeOf<
      | { readonly kind: "export"; readonly ref: "mail:count" }
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
