import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import notes from "./tables/notes.js";
import tags from "./tables/tags.js";
import users from "./tables/users.js";

export default $defineSchema({
  notes: $Table.tableDefinition(notes),
  tags: $Table.tableDefinition(tags),
  users: $Table.tableDefinition(users),
});
