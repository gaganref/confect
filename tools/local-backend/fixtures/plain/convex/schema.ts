import { defineSchema, defineTable } from "convex/server";

// The tables an id validator in `callbackArgs.ts` names, and another for an id
// of the wrong table.
export default defineSchema({
  documents: defineTable({}),
  others: defineTable({}),
});
