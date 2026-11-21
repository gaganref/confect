import { queryGeneric } from "convex/server";
import { runs } from "./provider";

/**
 * A plain Convex query, which runs no push check.
 */
export const read = queryGeneric({ args: {}, handler: () => "child served" });

/**
 * The provider's check runs, which importing it shares.
 */
export const checkRuns = runs;
