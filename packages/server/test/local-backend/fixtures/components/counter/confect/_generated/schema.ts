import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import counters from "./tables/counters";
import deliveries from "./tables/deliveries";
import systemIds from "./tables/systemIds";

import { target as $target } from "./id";
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
