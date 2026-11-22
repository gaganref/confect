import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import entries from "./tables/entries.js";

export default $defineSchema({
  entries: $Table.tableDefinition(entries),
});
