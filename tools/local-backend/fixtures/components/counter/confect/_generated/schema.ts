import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import counters from "./tables/counters.js";
import deliveries from "./tables/deliveries.js";
import systemIds from "./tables/systemIds.js";

import { target as $target } from "./id.js";
const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly counters: typeof counters;
  readonly deliveries: typeof deliveries;
  readonly systemIds: typeof systemIds;
}, typeof $target> = $DatabaseSchema.make({
  counters,
  deliveries,
  systemIds,
}, $target);

export default databaseSchema;
