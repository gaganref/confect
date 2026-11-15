import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The host's two table names. `others` has an index, so a push creates it, and
// numbers it, before `documents`, where the host numbers `documents` first.
export default defineSchema({
  documents: defineTable({}),
  others: defineTable({ n: v.number() }).index("by_n", ["n"]),
});
