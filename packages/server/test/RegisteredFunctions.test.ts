import { recording } from "./internal/recording";
import { scope } from "../src/internal/observability";
import { FunctionSpec, GroupSpec, MiddlewareSpec } from "@confect/core";
import {
  FunctionImpl,
  GroupImpl,
  MiddlewareImpl,
  RegisteredFunctions,
  RegisteredFunction,
} from "@confect/server";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  makeFunctionReference as reference,
  type RegisteredQuery,
} from "convex/server";
import { convexTest } from "convex-test";
import { RegisteredNodeFunction } from "@confect/server/node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
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
