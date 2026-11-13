import * as Arr from "effect/Array";

/**
 * The subject of the identity both targets' client presents.
 */
export const subject = "person";

/**
 * What `groups/componentIdentity` answers when called from a query, a mutation
 * or an action: the subject the host function reads, then the one each mount in
 * the chain `left`, `left/deep`, `left/deep/child` reads.
 */
export type Reading = {
  readonly caller: string | null;
  readonly chain: ReadonlyArray<{
    readonly componentPath: string;
    readonly subject: string | null;
  }>;
};

const reading = (component: string | null): Reading => ({
  caller: subject,
  chain: Arr.map(["left", "left/deep", "left/deep/child"], (componentPath) => ({
    componentPath,
    subject: component,
  })),
});

/**
 * What both targets answer. A component a query or a mutation calls runs on the
 * caller's transaction and sees its identity, at every depth. An action's call
 * into a component passes none
 * (`crates/isolate/src/environment/action/async_syscall.rs:166`,
 * `crates/model/src/components/auth.rs:6-19`,
 * `crates/isolate/src/environment/udf/async_syscall.rs:1111-1141`,
 * convex-backend `cccbade4`).
 */
export const expected = {
  query: reading(subject),
  mutation: reading(subject),
  action: reading(null),
};
