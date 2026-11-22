import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import entries from "./tables/entries.js";

import { target as $target } from "./id.js";
const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly entries: typeof entries;
}, typeof $target> = $DatabaseSchema.make({
  entries,
}, $target);

export default databaseSchema;
