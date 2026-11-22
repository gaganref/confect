import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import marks from "./tables/marks.js";

const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly marks: typeof marks;
}> = $DatabaseSchema.make({
  marks,
});

export default databaseSchema;
