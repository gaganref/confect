import * as PushCheck from "@confect/server/PushCheck";
import { queryGeneric } from "convex/server";
import ownerSchema from "./schema";
import { greet } from "./utility";

/**
 * The owner's database schema, for the layer that builds it as the app.
 */
export const schema = ownerSchema;

/**
 * A query that runs the owner's checks, as the group builders guard it.
 */
export const read = PushCheck.guardCopy(
  queryGeneric({ args: {}, handler: () => greet("owner") }),
  ownerSchema,
  "read",
);
