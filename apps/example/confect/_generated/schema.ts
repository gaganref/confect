import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import notes from "./tables/notes.js";
import tags from "./tables/tags.js";
import users from "./tables/users.js";

const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly notes: typeof notes;
  readonly tags: typeof tags;
  readonly users: typeof users;
}> = $DatabaseSchema.make({
  notes,
  tags,
  users,
});

export default databaseSchema;
