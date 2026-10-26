import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import demands from "./tables/demands.js";
import events from "./tables/events.js";
import notes from "./tables/notes.js";
import tags from "./tables/tags.js";
import totals from "./tables/totals.js";
import users from "./tables/users.js";

const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly demands: typeof demands;
  readonly events: typeof events;
  readonly notes: typeof notes;
  readonly tags: typeof tags;
  readonly totals: typeof totals;
  readonly users: typeof users;
}> = $DatabaseSchema.make({
  demands,
  events,
  notes,
  tags,
  totals,
  users,
});

export default databaseSchema;
