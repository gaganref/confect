import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import counters from "./tables/counters.js";
import deliveries from "./tables/deliveries.js";
import systemIds from "./tables/systemIds.js";

export default $defineSchema({
  counters: $Table.tableDefinition(counters),
  deliveries: $Table.tableDefinition(deliveries),
  systemIds: $Table.tableDefinition(systemIds),
});
