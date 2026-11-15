import { mutationGeneric } from "convex/server";
import { childTables } from "../convex/differentialShapes";

// IDs from this component's drawn tables, for an id validator in the host's
// namespace.

const drawnInserts = (ctx: {
  readonly db: {
    readonly insert: (table: never, value: never) => Promise<string>;
  };
}) => {
  const inserts: Array<Promise<string>> = [];
  for (const { name } of childTables)
    inserts.push(
      ctx.db.insert(name as never, { n: 0, s: "", e: [0, 0] } as never),
    );
  return inserts;
};

/**
 * A new document's id in each drawn table, by table.
 */
export const mint = mutationGeneric({
  args: {},
  handler: (ctx) =>
    Promise.all(drawnInserts(ctx)).then((drawn) => {
      const ids: Record<string, string> = {};
      for (const [position, { name }] of childTables.entries())
        ids[name] = drawn[position]!;
      return ids;
    }),
});
