import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import { RegisteredNodeFunction } from "@confect/server/node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A Confect Node action in a module with no `"use node"` directive, which
// Convex would run in its isolate.
const item = FunctionRegistryItem.make({
  functionSpec: FunctionSpec.publicNodeAction({
    name: "surface",
    returns: () => Schema.Null,
  }),
  groupMiddlewareAttachments: [],
  handler: () => Effect.succeed(null),
});

export const surface =
  item._tag === "Confect"
    ? RegisteredNodeFunction.make(DatabaseSchema.make({}), item)
    : undefined;
