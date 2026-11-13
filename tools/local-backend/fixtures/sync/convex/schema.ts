import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  counters: defineTable({ name: v.string(), value: v.number() }).index(
    "by_name",
    ["name"],
  ),
  notes: defineTable({ name: v.string(), text: v.string() }).index("by_name", [
    "name",
  ]),
});
