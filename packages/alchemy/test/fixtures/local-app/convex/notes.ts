import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import * as Array from "effect/Array";

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
      .then((notes) => Array.map(notes, (note) => note.text)),
});
