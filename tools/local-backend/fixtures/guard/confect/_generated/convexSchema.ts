import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import marks from "./tables/marks.js";

export default $defineSchema({
  marks: $Table.tableDefinition(marks),
});
