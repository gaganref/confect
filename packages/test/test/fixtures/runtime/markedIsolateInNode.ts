"use node";

import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A Confect action registered for Convex's isolate, in a module with a
// `"use node"` directive, which Convex would run in Node.
const item = FunctionRegistryItem.make({
  functionSpec: FunctionSpec.publicAction({
    name: "surface",
    returns: () => Schema.Null,
  }),
  groupMiddlewareAttachments: [],
  handler: () => Effect.succeed(null),
});

export const surface =
  item._tag === "Confect"
    ? RegisteredConvexFunction.make(DatabaseSchema.make({}), item)
    : undefined;
