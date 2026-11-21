import * as PushCheck from "@confect/server/PushCheck";
import schema from "./schema";

/**
 * How many times the check ran.
 */
export const runs = { check: 0 };

/**
 * A helper both entries use.
 */
export const greet = (name: string) => `hello ${name}`;

// The utility registers the owner's check at module scope, whichever entry
// loads it first.
PushCheck.register(
  schema,
  PushCheck.make("owner", () => {
    runs.check++;
    return [];
  }),
);
