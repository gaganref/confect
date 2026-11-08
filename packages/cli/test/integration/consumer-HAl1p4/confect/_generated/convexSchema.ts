import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import notes from "./tables/notes.js";

export default $defineSchema({
  notes: $Table.tableDefinition(notes),
});
