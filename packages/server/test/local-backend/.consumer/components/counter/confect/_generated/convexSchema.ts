import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import batches from "./tables/batches.js";
import emails from "./tables/emails.js";

export default $defineSchema({
  batches: $Table.tableDefinition(batches),
  emails: $Table.tableDefinition(emails),
});
