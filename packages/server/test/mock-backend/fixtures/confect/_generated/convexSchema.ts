import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import events from "./tables/events.js";
import notes from "./tables/notes.js";
import tags from "./tables/tags.js";
import users from "./tables/users.js";

export default $defineSchema({
  events: $Table.tableDefinition(events),
  notes: $Table.tableDefinition(notes),
  tags: $Table.tableDefinition(tags),
  users: $Table.tableDefinition(users),
});
