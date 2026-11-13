import {
  actionGeneric,
  makeFunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, v, type Value } from "convex/values";

// A function that throws a ConvexError, called from another through
// `ctx.runQuery`, `ctx.runMutation` or `ctx.runAction`. Each caller catches what
// reaches it and returns it, so a probe sees what the binary hands a caller
// across that boundary.

/**
 * The data each thrown `ConvexError` carries, by name.
 */
export const payloads = {
  int64: () => ({ code: 42n }),
  bytes: () => new Uint8Array([0, 1, 254, 255]).buffer,
  object: () => ({ outer: { inner: [1, "two", null], flag: true } }),
  string: () => "a plain message",
} satisfies Record<string, () => Value>;

export type Payload = keyof typeof payloads;

const payloadValidator = v.union(
  v.literal("int64"),
  v.literal("bytes"),
  v.literal("object"),
  v.literal("string"),
);

const fail = ({ payload }: { payload: Payload }): Promise<never> =>
  Promise.reject(new ConvexError(payloads[payload]()));

export const throwingQuery = queryGeneric({
  args: { payload: payloadValidator },
  handler: (_ctx, args) => fail(args),
});

export const throwingMutation = mutationGeneric({
  args: { payload: payloadValidator },
  handler: (_ctx, args) => fail(args),
});

export const throwingAction = actionGeneric({
  args: { payload: payloadValidator },
  handler: (_ctx, args) => fail(args),
});

const throwing = {
  query: makeFunctionReference<"query", { payload: Payload }>(
    "convexErrors:throwingQuery",
  ),
  mutation: makeFunctionReference<"mutation", { payload: Payload }>(
    "convexErrors:throwingMutation",
  ),
  action: makeFunctionReference<"action", { payload: Payload }>(
    "convexErrors:throwingAction",
  ),
};

/**
 * What reached the caller: whether it is a `ConvexError`, and its data or, for
 * any other error, its message.
 */
export type Caught =
  | { readonly convexError: true; readonly data: Value }
  | { readonly convexError: false; readonly message: string };

const caught = (call: () => Promise<unknown>): Promise<Caught> =>
  call().then(
    () => ({ convexError: false, message: "The call returned." }),
    (error: unknown) =>
      error instanceof ConvexError
        ? { convexError: true, data: error.data as Value }
        : { convexError: false, message: String(error) },
  );

export type Target = "query" | "mutation" | "action";

const targetValidator = v.union(
  v.literal("query"),
  v.literal("mutation"),
  v.literal("action"),
);

export const queryCaller = queryGeneric({
  args: { payload: payloadValidator },
  handler: (ctx, args) => caught(() => ctx.runQuery(throwing.query, args)),
});

export const mutationCaller = mutationGeneric({
  args: {
    payload: payloadValidator,
    target: v.union(v.literal("query"), v.literal("mutation")),
  },
  handler: (ctx, { payload, target }) =>
    caught(() =>
      target === "query"
        ? ctx.runQuery(throwing.query, { payload })
        : ctx.runMutation(throwing.mutation, { payload }),
    ),
});

/**
 * What a call from an action to a `target` that throws with `payload` data
 * reaches the action with.
 */
export const callFromAction = (
  ctx: GenericActionCtx<GenericDataModel>,
  { payload, target }: { payload: Payload; target: Target },
): Promise<Caught> =>
  caught(() =>
    target === "query"
      ? ctx.runQuery(throwing.query, { payload })
      : target === "mutation"
        ? ctx.runMutation(throwing.mutation, { payload })
        : ctx.runAction(throwing.action, { payload }),
  );

export const actionCaller = actionGeneric({
  args: { payload: payloadValidator, target: targetValidator },
  handler: callFromAction,
});
