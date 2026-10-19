import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import counters from "./tables/counters.js";

import { target as $target } from "./id.js";
const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly counters: typeof counters;
}, typeof $target> = $DatabaseSchema.make({
  counters,
}, $target);

export default databaseSchema;
