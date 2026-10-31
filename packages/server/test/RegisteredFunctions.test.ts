import { recording } from "./internal/recording";
import { FunctionSpec, GroupSpec, MiddlewareSpec } from "@confect/core";
import {
  FunctionImpl,
  GroupImpl,
  MiddlewareImpl,
  RegisteredFunctions,
  RegisteredFunction,
} from "@confect/server";
import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  makeFunctionReference as reference,
  type RegisteredQuery,
} from "convex/server";
import { convexTest } from "convex-test";
import type * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import componentSchema from "./local-backend/fixtures/components/counter/confect/_generated/schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
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

it.each(["query", "mutation", "action"] as const)(
  "traces the whole %s registration",
  // oxlint-disable-next-line effecttsgo/async-function -- convex-test exposes Promise boundaries for registered invocations.
  async (kind) => {
    class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}
    const failure = new Denied();
    const defect = new Error("broken");
    const console = { ...globalThis.console, info: vi.fn() };
    const { spans, messages, observability } = recording();
    expectTypeOf<Layer.Layer<never, "failed">>().not.toExtend<
      Parameters<typeof RegisteredConvexFunction.prepare>[3]
    >();
    const options = {
      name: "run" as const,
      args: () => ({ value: Schema.FiniteFromString }),
      returns: () => Schema.FiniteFromString,
      error: () => Denied,
    };
    const functionSpec = {
      query: FunctionSpec.publicQuery(options),
      mutation: FunctionSpec.publicMutation(options),
      action: FunctionSpec.publicAction(options),
    }[kind];
    const group = GroupSpec.make().addFunction(functionSpec);
    const schema = kind === "mutation" ? componentSchema : databaseSchema;
    const layer = GroupImpl.make(schema, group).pipe(
      Layer.provide(
        FunctionImpl.make(schema, group, "run", ({ value }) =>
          Effect.andThen(
            Effect.logInfo("checking"),
            value === -1
              ? Effect.fail(failure)
              : value === -2
                ? Effect.die(defect)
                : Effect.succeed(value + 1),
          ).pipe(Effect.provideService(Console.Console, console)),
        ),
      ),
      GroupImpl.finalize,
      Layer.merge(
        Layer.succeed(RegisteredFunction.Observability, observability),
      ),
    );
    const registered = RegisteredFunctions.buildForGroup<typeof group>(
      schema,
      layer,
    );
    const t = convexTest(undefined, {
      ...import.meta.glob("./mock-backend/fixtures/convex/_generated/*.js"),
      "./mock-backend/fixtures/convex/test.ts": () =>
        Promise.resolve(registered),
    });
    const invoke = (value: string) => {
      const args = { value };
      if (kind === "query")
        return t.query(reference<"query">("test:run"), args);
      if (kind === "mutation")
        return t.mutation(reference<"mutation">("test:run"), args);
      return t.action(reference<"action">("test:run"), args);
    };
    expect(await invoke("2")).toBe("3");
    expect(
      spans.map((span) => [
        span.name,
        span.attributes.get("kind"),
        span.parent._tag,
      ]),
    ).toEqual([["test:run", kind, "None"]]);
    if (kind === "query")
      expect(spans[0]!.status).toMatchObject({ startTime: 0n, endTime: 0n });
    await expect(invoke("invalid")).rejects.toThrow();
    expect(spans).toHaveLength(2);
    expect(spans[1]!.status).toMatchObject({
      _tag: "Ended",
      exit: { _tag: "Failure", cause: { reasons: [{ _tag: "Die" }] } },
    });
    /* oxlint-disable no-await-in-loop -- Each completed invocation is paired with its recorded span. */
    for (const [value, original] of [
      ["-1", failure],
      ["-2", defect],
    ] as const) {
      const result = invoke(value);
      if (value === "-1")
        await expect(result).rejects.toHaveProperty("data", { _tag: "Denied" });
      else await expect(result).rejects.toThrow("broken");
      const status = spans.at(-1)!.status;
      assert(status._tag === "Ended" && Exit.isFailure(status.exit));
      const extract = value === "-1" ? Cause.findError : Cause.findDefect;
      expect(Result.getOrThrow(extract(status.exit.cause))).toBe(original);
    }
    /* oxlint-enable no-await-in-loop */
    expect(messages).toEqual([["checking"], ["checking"], ["checking"]]);
    expect(console.info).not.toHaveBeenCalled();
    expect(spans).toHaveLength(4);
  },
);
