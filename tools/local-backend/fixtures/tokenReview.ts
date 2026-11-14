/**
 * What an HTTP action's handler sees of the token its request presents. The
 * handler runs whatever the verifier decides. A token the verifier accepts
 * gives `getUserIdentity` its identity. One it refuses makes `getUserIdentity`
 * throw: `errorClass` is the thrown value's constructor, `hasData` whether it
 * carries a `ConvexError`'s `data`, and `message` its message.
 */
export type TokenReview =
  | { readonly _tag: "identified"; readonly identity: unknown }
  | {
      readonly _tag: "threw";
      readonly errorClass: string;
      readonly hasData: boolean;
      readonly message: string;
    };

/**
 * The path both targets' fixtures route to a handler that answers its
 * `TokenReview` as JSON with status 200.
 */
export const path = "/token-review";

export const identified = (identity: unknown): TokenReview => ({
  _tag: "identified",
  identity,
});

export const threw = (thrown: unknown): TokenReview => {
  const error = thrown as { readonly message?: unknown } | null;
  return {
    _tag: "threw",
    errorClass:
      thrown !== null && typeof thrown === "object"
        ? thrown.constructor.name
        : typeof thrown,
    hasData: thrown !== null && typeof thrown === "object" && "data" in thrown,
    message: typeof error?.message === "string" ? error.message : "",
  };
};
