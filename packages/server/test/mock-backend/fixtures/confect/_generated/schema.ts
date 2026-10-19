import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import events from "./tables/events.js";
import notes from "./tables/notes.js";
import tags from "./tables/tags.js";
import users from "./tables/users.js";

const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly events: typeof events;
  readonly notes: typeof notes;
  readonly tags: typeof tags;
  readonly users: typeof users;
}> = $DatabaseSchema.make({
  events,
  notes,
  tags,
  users,
});

export default databaseSchema;
