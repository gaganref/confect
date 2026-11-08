import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Callback,
  Component,
  Env,
  FunctionSpec,
  GenericId,
  GroupSpec,
  IdScope,
  Mount,
  Ref,
} from "@confect/core";
import { getFunctionAddress } from "convex/server";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestSpec from "./TestSpec";

type Native = Record<string, Record<string, unknown>>;
const emailClient = (native: Native) => ({
  ref: native.delivery?.send,
  send: (message: string) => Effect.succeed(`sent ${message}`),
});
const Email = Component.make("email", {
  env: { REGION: Schema.String },
  client: emailClient,
});

const poolClient = (
  native: Native,
  options?: {
    readonly maxParallelism?: number;
    readonly initialBackoff?: number;
  },
) => ({ native, options });
const Workpool = Component.make("workpool", { client: poolClient });

const Strict = Component.make("strict", {
  client: (_native: Native, options: { readonly size: number }) => options,
});

const hostEnv = Env.make("tenant", {
  BULK_REGION: Env.string(),
  MAYBE_REGION: Env.optional(Env.string()),
});

const BulkEmail = Mount.make(Email, {
  name: "bulkEmail",
  httpPrefix: "/bulk-email",
  env: { REGION: hostEnv.BULK_REGION },
});
const TransactionalEmail = Mount.make(Email, {
  name: "transactionalEmail",
  env: { REGION: "eu-west-1" },
});
const ImportsPool = Mount.make(Workpool, {
  name: "importsPool",
  options: { maxParallelism: 10 },
});
const DefaultPool = Mount.make(Workpool, { name: "defaultPool" });

describe("Mount.make", () => {
  it("types the client from the component's client constructor", () => {
    expectTypeOf<Context.Service.Shape<typeof BulkEmail>>().toEqualTypeOf<
      ReturnType<typeof emailClient>
    >();
    expectTypeOf<Context.Service.Shape<typeof ImportsPool>>().toEqualTypeOf<
      ReturnType<typeof poolClient>
    >();
    expectTypeOf(
      Mount.make(Strict, { name: "strict", options: { size: 2 } }),
    ).toExtend<Context.Reference<{ readonly size: number }>>();
  });

  it("keeps what the mount was declared with", () => {
    expect(Mount.data(BulkEmail)).toEqual({
      component: Email,
      name: "bulkEmail",
      httpPrefix: "/bulk-email",
      env: { REGION: hostEnv.BULK_REGION },
    });
    expect(Mount.data(DefaultPool)).toEqual({
      component: Workpool,
      name: "defaultPool",
    });
  });

  it.effect("builds its default client from the component it names", () =>
    Effect.gen(function* () {
      const bulk = yield* BulkEmail;
      const transactional = yield* TransactionalEmail;
      expect(getFunctionAddress(bulk.ref)).toEqual({
        reference: "_reference/childComponent/bulkEmail/delivery/send",
      });
      expect(getFunctionAddress(transactional.ref)).toEqual({
        reference: "_reference/childComponent/transactionalEmail/delivery/send",
      });
      expect(yield* bulk.send("hello")).toBe("sent hello");
      expect((yield* ImportsPool).options).toEqual({ maxParallelism: 10 });
      expect((yield* DefaultPool).options).toBeUndefined();
    }),
  );

  it.effect("swaps the client inside provideService only", () =>
    Effect.gen(function* () {
      const fake = {
        ref: undefined,
        send: (message: string) => Effect.succeed(`fake ${message}`),
      };
      const sent = yield* Effect.gen(function* () {
        return yield* (yield* BulkEmail).send("hello");
      }).pipe(Effect.provideService(BulkEmail, fake));
      expect(sent).toBe("fake hello");
      expect(yield* (yield* BulkEmail).send("hello")).toBe("sent hello");
    }),
  );

  it("refuses what the component does not declare", () => {
    const n = { name: "bad" } as const;
    const o = { ...n, env: { REGION: "eu" } } as const;
    // @ts-expect-error RULE options-on-email: the email client takes no options.
    void Mount.make(Email, { ...o, options: {} });
    // @ts-expect-error RULE args-on-workpool: a component without init takes no args.
    void Mount.make(Workpool, { ...n, args: {} });
    // @ts-expect-error RULE env-on-workpool: a component without env takes no env.
    void Mount.make(Workpool, { ...n, env: {} });
    // @ts-expect-error RULE option-type: maxParallelism is a number.
    void Mount.make(Workpool, { ...n, options: { maxParallelism: "10" } });
    // @ts-expect-error RULE option-unknown-key: the pool has no surprise option.
    void Mount.make(Workpool, { ...n, options: { surprise: 1 } });
    // @ts-expect-error RULE official-option-name: the wrapper's option is initialBackoff.
    void Mount.make(Workpool, { ...n, options: { initialBackoffMs: 100 } });
    // @ts-expect-error RULE required-options: Strict's client requires options.
    void Mount.make(Strict, n);
    // @ts-expect-error RULE env-required: the email component declares required env.
    void Mount.make(Email, n);
    // @ts-expect-error RULE env-unknown-slot: the email component has no SURPRISE slot.
    void Mount.make(Email, { ...o, env: { REGION: "eu", SURPRISE: "x" } });
    // @ts-expect-error RULE env-optional-entry: an optional entry cannot fill a required slot.
    void Mount.make(Email, { ...o, env: { REGION: hostEnv.MAYBE_REGION } });
    // @ts-expect-error RULE env-not-prefix: an HTTP prefix does not stand in for required env.
    void Mount.make(Email, { ...n, httpPrefix: "/email" });
    // @ts-expect-error RULE no-testing: a component's test kit is found from its package.
    void Mount.make(Email, { ...o, testing: "email-kit/testing" });
    // @ts-expect-error RULE no-api: a mount takes no api.
    void Mount.make(Workpool, { ...n, httpPrefix: "/pool", api: {} });
    const Transport = Component.make("transport", {
      env: { MODE: Schema.Literals(["resend", "log"]) },
      client: (native: Native) => native,
    });
    // @ts-expect-error RULE env-missing-binding: a required slot cannot be left out.
    void Mount.make(Transport, { ...n, env: {} });
    // @ts-expect-error RULE env-literal-entry: a plain string entry cannot fill a literal slot.
    void Mount.make(Transport, { ...n, env: { MODE: hostEnv.BULK_REGION } });
    // @ts-expect-error RULE env-literal-value: a constant must be one of the slot's literals.
    void Mount.make(Transport, { ...n, env: { MODE: "smtp" } });
  });
});

const EventFields = {
  fromName: Schema.String,
  message: Schema.String,
  attempts: Schema.Int,
};
const OnEvent = Callback.mutation("mailer/onEvent", {
  args: () => EventFields,
  returns: () => Schema.Null,
});
const Mailer = Component.make("mailer", {
  init: Ref.make(
    "install",
    FunctionSpec.internalMutation({
      name: "init",
      args: () => ({
        fromName: Schema.String,
        maxAttempts: Schema.optionalKey(Schema.Int),
        onEvent: Schema.optionalKey(Callback.handle(OnEvent)),
      }),
      returns: () => Schema.Null,
    }),
  ),
  client: (native: Native) => native,
});
const onEvent = Ref.make(
  "callbacks",
  FunctionSpec.internalMutation({
    name: "onEvent",
    args: () => EventFields,
    returns: () => Schema.Null,
  }),
);

describe("Mount.make args", () => {
  it("keeps the install args, with a host ref in each callback slot", () => {
    const args = { fromName: "School office", onEvent };
    expect(Mount.data(Mount.make(Mailer, { name: "mailer", args }))).toEqual({
      component: Mailer,
      name: "mailer",
      args,
    });
  });

  it("refuses args init does not take", () => {
    const n = { name: "bad" } as const;
    const fromName = "office";
    const publicRef = Ref.make(
      "callbacks",
      FunctionSpec.publicMutation({
        name: "publicEvent",
        args: () => EventFields,
        returns: () => Schema.Null,
      }),
    );
    const wrongArgs = Ref.make(
      "callbacks",
      FunctionSpec.internalMutation({
        name: "args",
        args: () => ({ ...EventFields, fromName: Schema.Int }),
        returns: () => Schema.Null,
      }),
    );
    const returns = Ref.make(
      "callbacks",
      FunctionSpec.internalMutation({
        name: "returns",
        args: () => EventFields,
        returns: () => Schema.String,
      }),
    );
    const query = Ref.make(
      "callbacks",
      FunctionSpec.internalQuery({
        name: "queryEvent",
        args: () => EventFields,
        returns: () => Schema.Null,
      }),
    );
    // @ts-expect-error RULE callback-public: a callback is an internal host function.
    void Mount.make(Mailer, { ...n, args: { fromName, onEvent: publicRef } });
    // @ts-expect-error RULE callback-args: the target takes the args the contract sends.
    void Mount.make(Mailer, { ...n, args: { fromName, onEvent: wrongArgs } });
    // @ts-expect-error RULE callback-return: the target returns what the contract accepts.
    void Mount.make(Mailer, { ...n, args: { fromName, onEvent: returns } });
    // @ts-expect-error RULE callback-kind: a query cannot answer a mutation contract.
    void Mount.make(Mailer, { ...n, args: { fromName, onEvent: query } });
    // @ts-expect-error RULE args-required: init requires fromName.
    void Mount.make(Mailer, { ...n, args: { maxAttempts: 3 } });
    // @ts-expect-error RULE args-extra: init takes no surprise.
    void Mount.make(Mailer, { ...n, args: { fromName, surprise: true } });
  });
});

const scope = IdScope.component("notices");
const NoticeId = GenericId.GenericId("notices", scope);
const OnRead = Callback.mutation("notices/onRead", {
  args: () => ({ noticeId: NoticeId, reader: Schema.String }),
  returns: () => Schema.Null,
});
const noticesSpec = TestSpec.fromGroups({
  notices: GroupSpec.make().addFunction(
    FunctionSpec.publicQuery({
      name: "get",
      args: () => ({ noticeId: NoticeId }),
      returns: () => Schema.String,
    }),
  ),
});
const init = Ref.make(
  "install",
  FunctionSpec.internalMutation({
    name: "init",
    args: () => ({
      title: Schema.String,
      onRead: Schema.optionalKey(Callback.handle(OnRead)),
    }),
    returns: () => Schema.Null,
  }),
);
const Notices = Component.make("notices", {
  init,
  contract: Component.contract(noticesSpec, scope, ["notices"]),
  client: (native: Native) => native,
});
const School = Mount.make(Notices, { name: "school", args: { title: "A" } });
const Office = Mount.make(Notices, { name: "office", args: { title: "B" } });

describe("Mount callbackArgs", () => {
  it("returns the contract's args with ids typed for the mount", () => {
    const fields = School.callbackArgs("onRead");
    const encoded = { noticeId: "n1", reader: "ann" };
    const decoded = Schema.decodeUnknownSync(Schema.Struct(fields))(encoded);
    expect(decoded).toEqual(encoded);
    expect(Schema.encodeSync(Schema.Struct(fields))(decoded)).toEqual(encoded);
    expectTypeOf(decoded.reader).toEqualTypeOf<string>();
    expectTypeOf(decoded.noticeId).toEqualTypeOf<
      GenericId.GenericId<
        "notices",
        Component.MountScope<IdScope.App, "school">
      >
    >();
  });

  it("refuses what the mount cannot rebase", () => {
    const schoolId = Schema.decodeUnknownSync(
      Schema.Struct(School.callbackArgs("onRead")),
    )({ noticeId: "n1", reader: "ann" }).noticeId;
    const officeFields = Office.callbackArgs("onRead");
    // @ts-expect-error RULE callback-args-per-mount: an id rebased for one mount is not another's.
    const officeId: Schema.Schema.Type<typeof officeFields.noticeId> = schoolId;
    void officeId;
    const wrongSlot = () =>
      // @ts-expect-error RULE callback-args-slot: title is not a callback slot.
      School.callbackArgs("title");
    void wrongSlot;
    const plain = Mount.make(Mailer, { name: "m", args: { fromName: "x" } });
    // @ts-expect-error RULE callback-args-contract: a descriptor without a contract has no callbackArgs.
    void plain.callbackArgs;
  });
});
