import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import callbackEvents from "./tables/callbackEvents";
import transactionNotes from "./tables/transactionNotes";

export default $defineSchema({
  callbackEvents: $Table.tableDefinition(callbackEvents),
  transactionNotes: $Table.tableDefinition(transactionNotes),
});
