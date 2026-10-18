import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import counters from "./tables/counters";
import deliveries from "./tables/deliveries";
import systemIds from "./tables/systemIds";

export default $defineSchema({
  counters: $Table.tableDefinition(counters),
  deliveries: $Table.tableDefinition(deliveries),
  systemIds: $Table.tableDefinition(systemIds),
});
