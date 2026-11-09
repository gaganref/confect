import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import callbackEvents from "./tables/callbackEvents.js";
import commitStamps from "./tables/commitStamps.js";
import transactionNotes from "./tables/transactionNotes.js";

export default $defineSchema({
  callbackEvents: $Table.tableDefinition(callbackEvents),
  commitStamps: $Table.tableDefinition(commitStamps),
  transactionNotes: $Table.tableDefinition(transactionNotes),
});
