import * as Result from "effect/Result";
import { RegisteredNodeFunction } from "@confect/server/node";
import { DatabaseSchema, FunctionImpl, GroupImpl } from "@confect/server";
import { FunctionSpec, GroupSpec } from "@confect/core";
import * as SchemaToValidator from "@confect/core/SchemaToValidator";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import { afterEach, assert, expect, expectTypeOf, it } from "@effect/vitest";
import type { RegisteredAction } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

it("registers a Node group without a factory parameter", () => {
  const group = GroupSpec.makeNode().addFunction(
    FunctionSpec.publicNodeAction({
      name: "run",
      returns: () => Schema.String,
    }),
  );
  const database = DatabaseSchema.make({});
  const layer = GroupImpl.make(database, group).pipe(
    Layer.provide(
      FunctionImpl.make(database, group, "run", () => Effect.succeed("ok")),
    ),
    GroupImpl.finalize,
  );
  const registered = RegisteredNodeFunction.buildForGroup<typeof group>(
    database,
    layer,
  );
  expect(registered.run).toBeDefined();
  expectTypeOf(registered.run).toExtend<
    RegisteredAction<"public", Record<string, unknown>, unknown>
  >();
  expectTypeOf<
    Parameters<typeof RegisteredNodeFunction.buildForGroup>["length"]
  >().toEqualTypeOf<2>();
});

// `@confect/test`'s kernel reads the mark, since a module's "use node"
// directive is gone once it loads.
it("marks the runtime of a registered Node action as Node", () => {
  const item = FunctionRegistryItem.make({
    functionSpec: FunctionSpec.publicNodeAction({
      name: "get",
      returns: () => Schema.String,
    }),
    groupMiddlewareAttachments: [],
    handler: () => Effect.succeed("ok"),
  });
  assert(item._tag === "Confect");
  const registered = RegisteredNodeFunction.make(
    DatabaseSchema.make({}),
    item,
  ) as unknown as Record<symbol, unknown>;
  expect(registered[Symbol.for("@confect/server/NodeAction")]).toBe(true);
});

const options = {
  name: "enabled",
  args: () => ({ flags: Schema.Array(Schema.Boolean) }),
  returns: () => Schema.Boolean,
};

it.each([
  { visibility: "public", spec: FunctionSpec.publicNodeAction(options) },
  { visibility: "internal", spec: FunctionSpec.internalNodeAction(options) },
])("keeps $visibility Node validators lazy until export", ({ spec }) => {
  const compileArgs = vi.spyOn(SchemaToValidator, "compileArgsSchema");
  const compileReturns = vi.spyOn(SchemaToValidator, "compileReturnsSchema");
  const item = FunctionRegistryItem.make({
    functionSpec: spec,
    groupMiddlewareAttachments: [],
    handler: () => Effect.succeed(true),
  });
  assert(item._tag === "Confect");
  const registered = RegisteredNodeFunction.make(DatabaseSchema.make({}), item);
  expect(compileArgs).not.toHaveBeenCalled();
  expect(compileReturns).not.toHaveBeenCalled();

  const exported = registered as unknown as {
    exportArgs: () => string;
    exportReturns: () => string;
  };
  expect(
    Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
      exported.exportReturns(),
    ).pipe(Result.getOrThrow),
  ).toEqual({ type: "boolean" });
  expect(compileReturns).toHaveBeenCalledOnce();
  expect(compileArgs).not.toHaveBeenCalled();
  expect(
    Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
      exported.exportArgs(),
    ).pipe(Result.getOrThrow),
  ).toEqual({
    type: "object",
    value: {
      flags: {
        fieldType: { type: "array", value: { type: "boolean" } },
        optional: false,
      },
    },
  });
  exported.exportReturns();
  exported.exportArgs();
  expect(compileArgs).toHaveBeenCalledOnce();
  expect(compileReturns).toHaveBeenCalledOnce();
});
