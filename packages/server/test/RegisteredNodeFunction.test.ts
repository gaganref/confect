import { RegisteredNodeFunction } from "@confect/server/node";
import {
  DatabaseSchema,
  FunctionImpl,
  FunctionRegistryItem,
  GroupImpl,
} from "@confect/server";
import { FunctionSpec, GroupSpec } from "@confect/core";
import { assert, expect, expectTypeOf, it } from "@effect/vitest";
import type { RegisteredAction } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
