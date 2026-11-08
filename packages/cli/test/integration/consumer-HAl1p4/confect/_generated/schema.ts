import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import notes from "./tables/notes.js";

const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly notes: typeof notes;
}> = $DatabaseSchema.make({
  notes,
});

export default databaseSchema;
