import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The host's two table names. `others` has a staged index, which a push
// creates, and so numbers, as it creates any other index: before the
// unindexed `documents`, where the host numbers `documents` first.
export default defineSchema({
  documents: defineTable({}),
  others: defineTable({ n: v.number() }).index("by_n", {
    fields: ["n"],
    staged: true,
  }),
});
