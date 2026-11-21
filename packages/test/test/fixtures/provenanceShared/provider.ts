import * as PushCheck from "@confect/server/PushCheck";
import schema from "./schema";

/**
 * How many times the check ran.
 */
export const runs = { check: 0 };

// One provider two entries import registers the check at module scope, once,
// however many entries import it.
PushCheck.register(
  schema,
  PushCheck.make("shared", () => {
    runs.check++;
    return ["declaration tasks.read refuses"];
  }),
);
