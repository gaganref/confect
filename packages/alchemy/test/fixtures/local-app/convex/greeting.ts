import { queryGeneric } from "convex/server";

// Read at module load, which the backend runs while analysing a push: the
// push fails unless the variable was set before it.
// oxlint-disable-next-line effecttsgo/process-env -- a plain Convex function, not Effect code
const greeting = process.env.GREETING;
if (greeting === undefined)
  throw new Error("GREETING must be set before the first push");

export const get = queryGeneric({ args: {}, handler: () => greeting });
