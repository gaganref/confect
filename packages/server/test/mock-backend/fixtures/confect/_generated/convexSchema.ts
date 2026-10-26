import { defineSchema as $defineSchema } from "convex/server";
import { Table as $Table } from "@confect/server";

import demands from "./tables/demands.js";
import events from "./tables/events.js";
import notes from "./tables/notes.js";
import tags from "./tables/tags.js";
import totals from "./tables/totals.js";
import users from "./tables/users.js";

export default $defineSchema({
  demands: $Table.tableDefinition(demands),
  events: $Table.tableDefinition(events),
  notes: $Table.tableDefinition(notes),
  tags: $Table.tableDefinition(tags),
  totals: $Table.tableDefinition(totals),
  users: $Table.tableDefinition(users),
});
