import {
  actionGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type GenericActionCtx,
  type GenericDataModel,
} from "convex/server";
import * as TokenReview from "../../tokenReview";

// A function an HTTP action calls, through `ctx.runQuery`, `ctx.runMutation` or
// `ctx.runAction`, reads its own identity and returns what it got or what was
// thrown. A probe sees what the binary hands a callee of the request's token.

const review = (auth: {
  readonly getUserIdentity: () => Promise<unknown>;
}): Promise<TokenReview.TokenReview> =>
  auth.getUserIdentity().then(TokenReview.identified, TokenReview.threw);

export const reviewQuery = queryGeneric({
  args: {},
  handler: (ctx) => review(ctx.auth),
});

export const reviewMutation = mutationGeneric({
  args: {},
  handler: (ctx) => review(ctx.auth),
});

export const reviewAction = actionGeneric({
  args: {},
  handler: (ctx) => review(ctx.auth),
});

const reviewers = {
  query: makeFunctionReference<"query", {}, TokenReview.TokenReview>(
    "tokenReview:reviewQuery",
  ),
  mutation: makeFunctionReference<"mutation", {}, TokenReview.TokenReview>(
    "tokenReview:reviewMutation",
  ),
  action: makeFunctionReference<"action", {}, TokenReview.TokenReview>(
    "tokenReview:reviewAction",
  ),
};

/**
 * How an HTTP action calls a reviewer.
 */
export type Hop = keyof typeof reviewers;

export const hops: ReadonlyArray<Hop> = ["query", "mutation", "action"];

/**
 * The path the plain fixture routes to an HTTP action that calls the reviewer
 * its `hop` query parameter names and answers its review as JSON.
 */
export const path = "/token-review-hop";

export const reviewFrom = (
  ctx: GenericActionCtx<GenericDataModel>,
  hop: Hop,
): Promise<TokenReview.TokenReview> =>
  hop === "query"
    ? ctx.runQuery(reviewers.query, {})
    : hop === "mutation"
      ? ctx.runMutation(reviewers.mutation, {})
      : ctx.runAction(reviewers.action, {});
