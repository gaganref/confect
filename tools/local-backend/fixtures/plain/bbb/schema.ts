import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { childTables, type IndexKind } from "../convex/differentialShapes";

// The differential's drawn tables, one of each index kind, which a push numbers
// in its own namespace: the tables with an index first.

const drawn = () =>
  defineTable({ n: v.number(), s: v.string(), e: v.array(v.float64()) });

const withIndex = (index: IndexKind) => {
  switch (index) {
    case "none":
      return drawn();
    case "index":
      return drawn().index("by_n", ["n"]);
    case "staged index":
      return drawn().index("by_n", { fields: ["n"], staged: true });
    case "search index":
      return drawn().searchIndex("by_s", { searchField: "s" });
    case "staged search index":
      return drawn().searchIndex("by_s", { searchField: "s", staged: true });
    case "vector index":
      return drawn().vectorIndex("by_e", { vectorField: "e", dimensions: 2 });
    case "staged vector index":
      return drawn().vectorIndex("by_e", {
        vectorField: "e",
        dimensions: 2,
        staged: true,
      });
  }
};

const tables: Record<string, ReturnType<typeof drawn>> = {};
for (const { name, index } of childTables)
  tables[name] = withIndex(index) as never;

export default defineSchema(tables);
