import { queryGeneric } from "convex/server";

// The generated `server.ts` sits outside the typechecked graph (see the root
// tsconfig), so the query is built from `convex/server`.

/**
 * The identity this component reads from `ctx.auth`, then each nested mount's
 * below it, as plain Convex reads it.
 */
export const identityChain = queryGeneric({
  args: {},
  // oxlint-disable-next-line effecttsgo/async-function -- A vanilla Convex function reads ctx.auth as a raw component does.
  handler: async (
    ctx,
  ): Promise<
    Array<{ readonly componentPath: string; readonly subject: string | null }>
  > => {
    const identity = await ctx.auth.getUserIdentity();
    const { componentPath } = await ctx.meta.getFunctionMetadata();

    return [{ componentPath, subject: identity?.subject ?? null }];
  },
});
