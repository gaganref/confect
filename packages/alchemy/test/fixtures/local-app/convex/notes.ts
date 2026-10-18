import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const add = mutationGeneric({
  args: { text: v.string() },
  handler: (ctx, { text }) => ctx.db.insert("notes", { text }).then(() => null),
});

export const list = queryGeneric({
  args: {},
  handler: (ctx) =>
    ctx.db
      .query("notes")
      .collect()
      .then((notes) => notes.map((note) => note.text)),
});
