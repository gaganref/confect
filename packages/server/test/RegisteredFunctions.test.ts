import { recording } from "./internal/recording";
import { scope } from "../src/internal/observability";
import { FunctionSpec, GroupSpec, MiddlewareSpec, Ref } from "@confect/core";
import {
  ActionCtx,
  ActionRunner,
  Auth,
  FunctionImpl,
  GroupImpl,
  MiddlewareImpl,
  MutationRunner,
  QueryRunner,
  RegisteredFunctions,
  RegisteredFunction,
  Scheduler,
} from "@confect/server";
import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  makeFunctionReference as reference,
  type RegisteredQuery,
} from "convex/server";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { RegisteredNodeFunction } from "@confect/server/node";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Console from "effect/Console";
import type * as Tracer from "effect/Tracer";
import { vi } from "vitest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import databaseSchema from "./mock-backend/fixtures/confect/_generated/schema";
import registeredFunctions from "./mock-backend/fixtures/confect/_generated/registeredFunctions/groups/notes";
// Imported as a value (not `import type`) because its type parameterizes
// `buildForGroup` via `typeof notesSpec`, and `typeof` requires a value
// binding.
// oxlint-disable-next-line typescript/consistent-type-imports
import notesSpec from "./mock-backend/fixtures/confect/groups/notes.spec";
import notes from "./mock-backend/fixtures/confect/groups/notes.impl";

describe("Registered functions", () => {
  it("types public Query functions as RegisteredQuery<public, ...>", () => {
    expectTypeOf(registeredFunctions.list).toExtend<
      RegisteredQuery<"public", Record<string, unknown>, unknown>
    >();
    expectTypeOf(registeredFunctions.getFirst).toExtend<
      RegisteredQuery<"public", Record<string, unknown>, unknown>
    >();
  });

  it("types internal Query functions as RegisteredQuery<internal, ...>", () => {
    expectTypeOf(registeredFunctions.internalGetFirst).toExtend<
      RegisteredQuery<"internal", Record<string, unknown>, unknown>
    >();
  });
});

describe("buildForGroup", () => {
  it("accepts only the schema and finalized group layer", () => {
    expectTypeOf<
      Parameters<typeof RegisteredFunctions.buildForGroup>["length"]
    >().toEqualTypeOf<2>();
  });
  it("rejects an implementation registered for a different same-key spec", () => {
    class Policy extends MiddlewareSpec.MiddlewareSpec<Policy>()("Policy", {
      options: () => Schema.Struct({ label: Schema.String }),
      functionTypes: { query: true, mutation: false, action: false },
    }) {}
    class OtherPolicy extends MiddlewareSpec.MiddlewareSpec<OtherPolicy>()(
      "Policy",
      {
        options: () => Schema.Struct({ count: Schema.Finite }),
        functionTypes: { query: true, mutation: false, action: false },
      },
    ) {}
    class SameShapePolicy extends MiddlewareSpec.MiddlewareSpec<SameShapePolicy>()(
      "Policy",
      {
        options: () => Schema.Struct({ label: Schema.String }),
        functionTypes: { query: true, mutation: false, action: false },
      },
    ) {}

    const query = FunctionSpec.publicQuery({
      name: "get",
      returns: () => Schema.String,
    }).middleware(Policy, { label: "internal" });
    const group = GroupSpec.make().addFunction(query);

    for (const implementationSpec of [OtherPolicy, SameShapePolicy]) {
      const layer = GroupImpl.make(databaseSchema, group).pipe(
        Layer.provide(
          FunctionImpl.make(databaseSchema, group, "get", () =>
            Effect.succeed("ok"),
          ),
        ),
        Layer.provide(
          MiddlewareImpl.make(
            databaseSchema,
            implementationSpec,
            (effect) => effect,
          ),
        ),
        GroupImpl.finalize,
      );
      expect(() =>
        RegisteredFunctions.buildForGroup<typeof group>(databaseSchema, layer),
      ).toThrowError(/Middleware "Policy".*function "get".*different spec/);
    }
  });

  it("rejects equivalent options during registration without requiring codegen", () => {
    class GroupPolicy extends MiddlewareSpec.MiddlewareSpec<GroupPolicy>()(
      "GroupPolicy",
      {
        options: () => Schema.Struct({ label: Schema.String }),
        functionTypes: { query: true, mutation: true, action: true },
      },
    ) {}

    const query = FunctionSpec.publicQuery({
      name: "get",
      returns: () => Schema.String,
    }).middleware(GroupPolicy, { label: "same" });
    const group = GroupSpec.make()
      .middleware(GroupPolicy, { label: "same" })
      .addFunction(query);
    const layer = GroupImpl.make(databaseSchema, group).pipe(
      Layer.provide(
        FunctionImpl.make(databaseSchema, group, "get", () =>
          Effect.succeed("ok"),
        ),
      ),
      Layer.provide(
        MiddlewareImpl.make(databaseSchema, GroupPolicy, (effect) => effect),
      ),
      GroupImpl.finalize,
    );
    expect(() =>
      RegisteredFunctions.buildForGroup<typeof group>(databaseSchema, layer),
    ).toThrowError(/GroupPolicy.*equivalent options.*function "get"/);
  });

  it("registers only the requested group", () => {
    const registered = RegisteredFunctions.buildForGroup<typeof notesSpec>(
      databaseSchema,
      notes,
    );

    expect(registered.list).toBeDefined();
    expect(registered.insert).toBeDefined();
  });
});

it.each(["query", "mutation", "action", "node"] as const)(
  "traces the whole %s registration",
  // oxlint-disable-next-line effecttsgo/async-function -- convex-test exposes Promise boundaries for registered invocations.
  async (kind) => {
    const console = { ...globalThis.console, info: vi.fn() };
    const recorder = recording();
    const { spans, messages, observability } = recorder;
    const options = {
      name: "run" as const,
      args: () => ({ value: Schema.Finite }),
      returns: () => Schema.Finite,
    };
    const { publicQuery, publicMutation, publicAction, publicNodeAction } =
      FunctionSpec;
    const group = {
      query: GroupSpec.make().addFunction(publicQuery(options)),
      mutation: GroupSpec.make().addFunction(publicMutation(options)),
      action: GroupSpec.make().addFunction(publicAction(options)),
      node: GroupSpec.makeNode().addFunction(publicNodeAction(options)),
    }[kind];
    const schema = databaseSchema;
    const layer = GroupImpl.make(schema, group).pipe(
      Layer.provide(
        FunctionImpl.make(schema, group, "run", ({ value }) =>
          Effect.as(Effect.logInfo("checking"), value + 1).pipe(
            Effect.provideService(Console.Console, console),
          ),
        ),
      ),
      GroupImpl.finalize,
      Layer.merge(
        Layer.succeed(
          RegisteredFunction.Observability,
          Layer.unwrap(
            Config.String("PATH").pipe(Effect.orDie, Effect.as(observability)),
          ),
        ),
      ),
    );
    const registered =
      kind === "node"
        ? RegisteredNodeFunction.buildForGroup<typeof group>(schema, layer)
        : RegisteredFunctions.buildForGroup<typeof group>(schema, layer);
    const t = convexTest(undefined, {
      ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
      "./mock-backend/fixtures/convex/test.ts": () =>
        Promise.resolve(registered),
    });
    const invoke = (value: number) =>
      kind === "query"
        ? t.query(reference<"query">("test:run"), { value })
        : kind === "mutation"
          ? t.mutation(reference<"mutation">("test:run"), { value })
          : t.action(reference<"action">("test:run"), { value });
    const finalizers = [];
    for (const count of [1, 9, 90]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Observe ownership at successive invocation counts.
        await Promise.all(Array.from({ length: count }, () => invoke(2))),
      ).toEqual(Array(count).fill(3));
      if (scope.state._tag === "Open")
        finalizers.push(scope.state.finalizers?.size ?? 1);
      expect(recorder.lifecycle).toEqual({ builds: 1, releases: 0 });
    }
    expect(finalizers).toEqual([finalizers[0], finalizers[0], finalizers[0]]);
    expect(spans).toHaveLength(100);
    for (const { name, attributes, parent } of spans) {
      expect([name, attributes.get("kind"), parent._tag]).toEqual([
        "test:run",
        kind === "node" ? "action" : kind,
        "None",
      ]);
    }
    expect(messages).toEqual(Array.from({ length: 100 }, () => ["checking"]));
    expect(console.info).not.toHaveBeenCalled();
  },
);

describe("a registered action", () => {
  class Denied extends Schema.TaggedError<
    Denied,
    { readonly brand: unique symbol }
  >()("Denied", { reason: Schema.String }) {}
  class Outer extends MiddlewareSpec.MiddlewareSpec<Outer>()("Outer", {
    functionTypes: { query: false, mutation: false, action: true },
  }) {}
  class Inner extends MiddlewareSpec.MiddlewareSpec<Inner>()("Inner", {
    functionTypes: { query: false, mutation: false, action: true },
  }) {}

  const ping = FunctionSpec.publicQuery({
    name: "ping",
    returns: () => Schema.String,
  });
  const run = FunctionSpec.publicAction({
    name: "run",
    args: () => ({
      mode: Schema.Literals(["ok", "fail", "die"]),
      count: Schema.FiniteFromString,
    }),
    returns: () => Schema.FiniteFromString,
    error: () => Denied,
  }).middleware(Inner);
  const pings = GroupSpec.make().addFunction(ping);
  const group = GroupSpec.make().middleware(Outer).addFunction(run);

  const invoke = (args: { mode: string; count: string }) => {
    const { spans, observability } = recording();
    const events: Array<unknown> = [];
    const parents: Array<Tracer.AnySpan> = [];
    const parent = Effect.orDie(Effect.currentParentSpan).pipe(
      Effect.map((span) => parents.push(span)),
    );
    const marked =
      (label: string) =>
      <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        { invocation }: { readonly invocation: unknown },
      ) =>
        Effect.gen(function* () {
          events.push([label, invocation]);
          yield* parent;
          const result = yield* effect;
          events.push(`${label}:after`);
          return result;
        });
    const pingLayer = GroupImpl.make(databaseSchema, pings).pipe(
      Layer.provide(
        FunctionImpl.make(databaseSchema, pings, "ping", () =>
          Effect.succeed("pong"),
        ),
      ),
      GroupImpl.finalize,
    );
    const layer = GroupImpl.make(databaseSchema, group).pipe(
      Layer.provide(
        FunctionImpl.make(databaseSchema, group, "run", ({ mode, count }) =>
          Effect.gen(function* () {
            events.push("handler");
            yield* parent;
            if (mode === "fail")
              return yield* Denied.make({ reason: "closed" });
            if (mode === "die") return yield* Effect.die(new Error("broken"));
            const services = yield* Effect.all([
              Effect.serviceOption(ActionCtx.ActionCtx()),
              Effect.serviceOption(QueryRunner.QueryRunner),
              Effect.serviceOption(MutationRunner.MutationRunner),
              Effect.serviceOption(ActionRunner.ActionRunner),
              Effect.serviceOption(Scheduler.Scheduler),
              Effect.serviceOption(Auth.Auth),
            ]);
            events.push([
              "services",
              Arr.every(services, (service) => service._tag === "Some"),
            ]);
            const runner = yield* QueryRunner.QueryRunner;
            const pingRef = Ref.make("pings", ping);
            events.push([
              "pinged",
              yield* Effect.all([
                runner.runQuery(pingRef),
                runner.runQuery(pingRef),
              ]).pipe(Effect.orDie),
            ]);
            return count * 2;
          }),
        ),
      ),
      Layer.provide(
        MiddlewareImpl.make(databaseSchema, Outer, marked("outer")),
      ),
      Layer.provide(
        MiddlewareImpl.make(databaseSchema, Inner, marked("inner")),
      ),
      GroupImpl.finalize,
      Layer.merge(
        Layer.succeed(RegisteredFunction.Observability, observability),
      ),
    );
    const t = convexTest(undefined, {
      ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
      "./mock-backend/fixtures/convex/test.ts": () =>
        Promise.resolve(
          RegisteredFunctions.buildForGroup<typeof group>(
            databaseSchema,
            layer,
          ),
        ),
      "./mock-backend/fixtures/convex/pings.ts": () =>
        Promise.resolve(
          RegisteredFunctions.buildForGroup<typeof pings>(
            databaseSchema,
            pingLayer,
          ),
        ),
    });
    const result = t.action(reference<"action">("test:run"), args);
    return { result, events, parents, spans };
  };
  const invocation = (mode: string) => ({
    name: "run",
    functionType: "action",
    functionVisibility: "public",
    args: { mode, count: 3 },
  });

  it(
    "runs group then function middleware around the handler, with the action's services, under one root span",
    // oxlint-disable-next-line effecttsgo/async-function -- convex-test exposes Promise boundaries for registered invocations.
    async () => {
      const { result, events, parents, spans } = invoke({
        mode: "ok",
        count: "3",
      });
      expect(await result).toBe("6");
      expect(events).toEqual([
        ["outer", invocation("ok")],
        ["inner", invocation("ok")],
        "handler",
        ["services", true],
        ["pinged", ["pong", "pong"]],
        "inner:after",
        "outer:after",
      ]);
      const roots = Arr.filter(spans, ({ name }) => name === "test:run");
      expect(roots).toHaveLength(1);
      const [root] = roots;
      expect([root?.attributes.get("kind"), root?.parent._tag]).toEqual([
        "action",
        "None",
      ]);
      expect(parents).toEqual([root, root, root]);
    },
  );

  it(
    "encodes a declared failure into ConvexError data and ends the span with it",
    // oxlint-disable-next-line effecttsgo/async-function -- convex-test exposes Promise boundaries for registered invocations.
    async () => {
      const { result, events, spans } = invoke({ mode: "fail", count: "3" });
      const error: unknown = await result.catch((thrown: unknown) => thrown);
      assert(error instanceof ConvexError);
      expect(error.data).toEqual({ _tag: "Denied", reason: "closed" });
      expect(events).toEqual([
        ["outer", invocation("fail")],
        ["inner", invocation("fail")],
        "handler",
      ]);
      const status = spans[0]?.status;
      assert(status?._tag === "Ended" && Exit.isFailure(status.exit));
      expect(Cause.squash(status.exit.cause)).toBeInstanceOf(Denied);
    },
  );

  it(
    "rejects a defect as a plain error",
    // oxlint-disable-next-line effecttsgo/async-function -- convex-test exposes Promise boundaries for registered invocations.
    async () => {
      const { result } = invoke({ mode: "die", count: "3" });
      const error: unknown = await result.catch((thrown: unknown) => thrown);
      assert(error instanceof Error && !(error instanceof ConvexError));
      expect(error.message).toContain("broken");
    },
  );

  it(
    "dies on args that fail to decode before any middleware runs",
    // oxlint-disable-next-line effecttsgo/async-function -- convex-test exposes Promise boundaries for registered invocations.
    async () => {
      const { result, events } = invoke({ mode: "ok", count: "three" });
      const error: unknown = await result.catch((thrown: unknown) => thrown);
      assert(error instanceof Error && !(error instanceof ConvexError));
      expect(events).toEqual([]);
    },
  );
});
