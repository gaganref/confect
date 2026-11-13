import { componentsGeneric, queryGeneric } from "convex/server";
import type { ComponentApi } from "../../inner/convex/_generated/component";

// The generated `api.ts` and `server.ts` sit outside the typechecked graph
// (see the root tsconfig), so the query is built from `convex/server` and
// the nested mount is typed by its own `ComponentApi`.
const components = componentsGeneric() as unknown as {
  child: ComponentApi<"child">;
};

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
    const below = await ctx.runQuery(components.child.parent.identityChain, {});
    return [{ componentPath, subject: identity?.subject ?? null }, ...below];
  },
});
