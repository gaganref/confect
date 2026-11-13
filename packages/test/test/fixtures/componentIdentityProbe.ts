/**
 * The subject of the identity both targets' client presents.
 */
export const subject = "person";

/**
 * What `groups/componentIdentity` answers when called from a query, a
 * mutation or an action: the subject the host function reads, then the one
 * each mount in the chain `left`, `left/deep`, `left/deep/child` reads.
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
  chain: ["left", "left/deep", "left/deep/child"].map((componentPath) => ({
    componentPath,
    subject: component,
  })),
});

/**
 * The kernel: a component runs with no identity, whoever calls it.
 */
export const kernel = {
  query: reading(null),
  mutation: reading(null),
  action: reading(null),
};

/**
 * Conformance exception `componentIdentityThroughTransactions`. The binary
 * gives a component the caller's identity when a query or a mutation calls it,
 * at every depth, and none when an action does. Only an action's call passes
 * the identity through `propagate_component_auth`
 * (`crates/isolate/src/environment/action/async_syscall.rs:166`,
 * `crates/model/src/components/auth.rs:6-19`). A query's or mutation's nested
 * call keeps the caller's transaction, whose identity `getUserIdentity` reads
 * in a component too (`isolate/src/environment/udf/async_syscall.rs:629-724`,
 * `:1111-1141`), convex-backend `cccbade4`. The kernel keeps the design's rule
 * instead. The exact test is the binary leg in
 * `packages/server/test/local-backend/componentIdentity.test.ts`. The owner is
 * the kernel design's component-identity row, which decides whether the kernel
 * follows the binary.
 */
export const binary = {
  query: reading(subject),
  mutation: reading(subject),
  action: reading(null),
};
