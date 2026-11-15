import {
  actionGeneric,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
} from "convex/server";

// IDs from this component's tables, for an id validator in the host's namespace.

export const noop = internalMutationGeneric({
  args: {},
  handler: () => Promise.resolve(null),
});

/**
 * A new document's id in each table, and a scheduled job's.
 */
export const mint = mutationGeneric({
  args: {},
  handler: (ctx) =>
    Promise.all([
      ctx.db.insert("documents", {}),
      ctx.db.insert("others", { n: 0 }),
      ctx.scheduler.runAfter(
        1e9,
        makeFunctionReference<"mutation">("ids:noop"),
        {},
      ),
    ]).then(([documents, others, scheduled]) => ({
      documents,
      others,
      scheduled,
    })),
});

/**
 * A stored file's id.
 */
export const store = actionGeneric({
  args: {},
  handler: (ctx) => ctx.storage.store(new Blob(["aaa"])),
});
