import * as PushCheck from "@confect/server/PushCheck";
import schema from "./schema";

/**
 * How many times the check ran.
 */
export const runs = { check: 0 };

// A provider every entry imports registers the component's check at module
// scope, as Frame's door does.
PushCheck.register(
  schema,
  PushCheck.make("provenance", () => {
    runs.check++;
    return ["declaration tasks.read refuses"];
  }),
);
