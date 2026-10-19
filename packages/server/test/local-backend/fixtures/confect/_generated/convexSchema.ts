import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import callbackEvents from "./tables/callbackEvents.js";
import transactionNotes from "./tables/transactionNotes.js";

export default $defineSchema({
  callbackEvents: $Table.tableDefinition(callbackEvents),
  transactionNotes: $Table.tableDefinition(transactionNotes),
});
