import { FunctionSpec, IdScope, Ref } from "@confect/core";
import * as ActionCtx from "@confect/server/ActionCtx";
import * as ActionRunner from "@confect/server/ActionRunner";
import * as MutationCtx from "@confect/server/MutationCtx";
import * as MutationRunner from "@confect/server/MutationRunner";
import * as OfficialComponent from "@confect/server/OfficialComponent";
import * as QueryCtx from "@confect/server/QueryCtx";
import * as QueryRunner from "@confect/server/QueryRunner";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { getFunctionName } from "convex/server";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// Official clients declare the narrow ctx each method needs, as these do.
type Run<Kind extends "query" | "mutation" | "action"> = <
  F extends FunctionReference<Kind, "internal">,
>(
  fn: F,
  args: FunctionArgs<F>,
) => Promise<FunctionReturnType<F>>;
type RunQueryCtx = { runQuery: Run<"query"> };
type RunMutationCtx = { runMutation: Run<"mutation"> };
type RunActionCtx = { runAction: Run<"action"> };

const run = () => Promise.reject(new Error("the lifted call reads no runner"));
const runners = {
  query: QueryRunner.layer(run),
  mutation: MutationRunner.layer(run),
  action: ActionRunner.layer(run),
};

// A Confect handler provides its native ctx alongside the runners its kind allows.
const handler = {
  query: (ctx: object) =>
    Layer.mergeAll(
      QueryCtx.layer(ctx as GenericQueryCtx<GenericDataModel>, IdScope.app),
      runners.query,
    ),
  mutation: (ctx: object) =>
    Layer.mergeAll(
      MutationCtx.layer(
        ctx as GenericMutationCtx<GenericDataModel>,
        IdScope.app,
      ),
      runners.query,
      runners.mutation,
    ),
  action: (ctx: object) =>
    Layer.mergeAll(
      ActionCtx.layer(ctx as GenericActionCtx<GenericDataModel>, IdScope.app),
      runners.query,
      runners.mutation,
      runners.action,
    ),
};

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Result.getOrThrow(Cause.findDefect(exit.cause))
    : undefined;

class Counter {
  readonly calls: Array<ReadonlyArray<unknown>> = [];
  constructor(readonly name: string) {}

  count(ctx: RunQueryCtx, key: string): Promise<string> {
    this.calls.push([ctx, key]);
    return Promise.resolve(`${this.name}:${key}`);
  }

  add(_ctx: RunMutationCtx, _amount: number): Promise<number> {
    return Promise.reject(new Error("over the limit"));
  }

  flush(_ctx: RunActionCtx) {
    return Promise.resolve(null);
  }

  snapshot(_ctx: GenericQueryCtx<GenericDataModel>) {
    return Promise.resolve(0);
  }

  label(): string {
    return this.name;
  }
}

describe("make", () => {
  it("derives each method's runner from its ctx parameter", () => {
    const counter = OfficialComponent.make("counter", new Counter("c"));
    type Method = Parameters<typeof counter>[0];

    expectTypeOf(counter("count", "a")).toEqualTypeOf<
      Effect.Effect<string, never, QueryRunner.QueryRunner>
    >();
    expectTypeOf(counter("add", 1)).toEqualTypeOf<
      Effect.Effect<number, never, MutationRunner.MutationRunner>
    >();
    expectTypeOf(counter("flush")).toEqualTypeOf<
      Effect.Effect<null, never, ActionRunner.ActionRunner>
    >();
    expectTypeOf<Method>().toEqualTypeOf<"count" | "add" | "flush">();
  });

  it("lifts generic methods with their inferred parameters", () => {
    type Limits = { messages: number; uploads: number };
    const official = {
      limit<Name extends keyof Limits>(
        _ctx: RunMutationCtx,
        _name: Name,
        ..._options: Name extends keyof Limits
          ? [options?: { count: number }]
          : [options: { count: number }]
      ): Promise<boolean> {
        return Promise.resolve(true);
      },
      remaining(_ctx: RunQueryCtx, _name: keyof Limits): Promise<number> {
        return Promise.resolve(10);
      },
    };
    const limiter = OfficialComponent.make("limiter", official);
    type Method = Parameters<typeof limiter>[0];

    expectTypeOf<Method>().toEqualTypeOf<"limit" | "remaining">();
    expectTypeOf(limiter("limit", "messages")).toEqualTypeOf<
      Effect.Effect<boolean, never, MutationRunner.MutationRunner>
    >();
    expectTypeOf(limiter("limit", "uploads", { count: 2 })).toEqualTypeOf<
      Effect.Effect<boolean, never, MutationRunner.MutationRunner>
    >();
    expectTypeOf(limiter("remaining", "messages")).toEqualTypeOf<
      Effect.Effect<number, never, QueryRunner.QueryRunner>
    >();
    // @ts-expect-error Only configured limit names are accepted.
    const _missingName = limiter("limit", "missing");
    // @ts-expect-error The generic method's options retain their field types.
    const _wrongCount = limiter("limit", "messages", { count: "two" });
    // @ts-expect-error The plain method still requires its name argument.
    const _missingArgument = limiter("remaining");
  });

  it.effect.each(["query", "mutation", "action"] as const)(
    "passes the native %s ctx and the arguments to the official method",
    (kind) =>
      Effect.gen(function* () {
        const official = new Counter("c");
        const native = { kind };
        const counter = OfficialComponent.make("counter", official);

        const layer: Layer.Layer<QueryRunner.QueryRunner> =
          handler[kind](native);

        const result = yield* counter("count", "a").pipe(Effect.provide(layer));

        expect(result).toBe("c:a");
        expect(official.calls).toEqual([[native, "a"]]);
        expect(official.calls[0]?.[0]).toBe(native);
      }),
  );

  it.effect(
    "dies with ComponentCallFailed when the official method rejects",
    () =>
      Effect.gen(function* () {
        const counter = OfficialComponent.make("counter", new Counter("c"));

        const exit = yield* Effect.exit(
          counter("add", 1).pipe(Effect.provide(handler.mutation({}))),
        );

        const defect = defectOf(exit);
        expect(defect).toBeInstanceOf(OfficialComponent.ComponentCallFailed);
        expect(defect).toMatchObject({
          _tag: "ComponentCallFailed",
          component: "counter",
          method: "add",
          cause: new Error("over the limit"),
        });
      }),
  );

  it.effect("dies when called outside a Confect handler", () =>
    Effect.gen(function* () {
      const counter = OfficialComponent.make("counter", new Counter("c"));

      const exit = yield* Effect.exit(
        counter("count", "a").pipe(Effect.provide(runners.query)),
      );

      expect(defectOf(exit)).toEqual(
        new Error("counter called outside a Confect handler"),
      );
    }),
  );
});

const record = Ref.make(
  "counter",
  FunctionSpec.internalMutation({
    name: "record",
    args: () => ({ value: Schema.FiniteFromString, note: Schema.String }),
    returns: () => Schema.Null,
  }),
);

describe("encodeCall", () => {
  it.effect("encodes the ref's arguments through its codecs", () =>
    Effect.gen(function* () {
      const call = yield* OfficialComponent.encodeCall(record, {
        value: 42,
        note: "n",
      });

      expect(getFunctionName(call.reference)).toBe("counter:record");
      expect(call.args).toEqual({ value: "42", note: "n" });
    }),
  );
});

describe("encodeField", () => {
  it.effect("encodes one declared field through its codec", () =>
    Effect.gen(function* () {
      expect(yield* OfficialComponent.encodeField(record, "value", 42)).toBe(
        "42",
      );
    }),
  );
});
