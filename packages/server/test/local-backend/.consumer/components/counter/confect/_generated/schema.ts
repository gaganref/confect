import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import batches from "./tables/batches.js";
import emails from "./tables/emails.js";

import { target as $target } from "./id.js";
const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly batches: typeof batches;
  readonly emails: typeof emails;
}, typeof $target> = $DatabaseSchema.make({
  batches,
  emails,
}, $target);

export default databaseSchema;
