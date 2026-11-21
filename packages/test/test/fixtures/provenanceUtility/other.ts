import { queryGeneric } from "convex/server";
import { greet } from "./utility";

/**
 * A plain Convex query that uses the shared utility and runs no push check.
 */
export const read = queryGeneric({ args: {}, handler: () => greet("other") });
