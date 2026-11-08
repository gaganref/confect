import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Component, Env, Mount } from "@confect/core";
import { getFunctionAddress } from "convex/server";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
  });
});
