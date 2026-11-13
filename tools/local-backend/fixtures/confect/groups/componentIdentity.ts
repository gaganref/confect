import { components } from "../../convex/_generated/api";
import { action, mutation, query } from "../../convex/_generated/server";

/**
 * The identity the host function reads, and what each nested mount under `left`
 * reads, as plain Convex functions and components read `ctx.auth`.
 */
type Reading = {
  readonly caller: string | null;
  readonly chain: Array<{
    readonly componentPath: string;
    readonly subject: string | null;
  }>;
};

export const fromQuery = query({
  args: {},
  // oxlint-disable-next-line effecttsgo/async-function -- A vanilla Convex function reads ctx.auth as a raw component does.
  handler: async (ctx): Promise<Reading> => ({
    caller: (await ctx.auth.getUserIdentity())?.subject ?? null,
    chain: await ctx.runQuery(components.left.parent.identityChain, {}),
  }),
});

export const fromMutation = mutation({
  args: {},
  // oxlint-disable-next-line effecttsgo/async-function -- A vanilla Convex function reads ctx.auth as a raw component does.
  handler: async (ctx): Promise<Reading> => ({
    caller: (await ctx.auth.getUserIdentity())?.subject ?? null,
    chain: await ctx.runQuery(components.left.parent.identityChain, {}),
  }),
});

export const fromAction = action({
  args: {},
  // oxlint-disable-next-line effecttsgo/async-function -- A vanilla Convex function reads ctx.auth as a raw component does.
  handler: async (ctx): Promise<Reading> => ({
    caller: (await ctx.auth.getUserIdentity())?.subject ?? null,
    chain: await ctx.runQuery(components.left.parent.identityChain, {}),
  }),
});
