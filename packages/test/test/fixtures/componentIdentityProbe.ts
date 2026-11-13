/**
 * The subject of the identity both targets' client presents.
 */
export const subject = "person";

/**
 * What `groups/componentIdentity` answers when called from a query, a
 * mutation or an action: the host function sees the client, and every
 * component in the mount chain `left`, `left/deep`, `left/deep/child` sees no
 * identity.
 */
export type Reading = {
  readonly caller: string | null;
  readonly chain: ReadonlyArray<{
    readonly componentPath: string;
    readonly subject: string | null;
  }>;
};

const reading: Reading = {
  caller: subject,
  chain: [
    { componentPath: "left", subject: null },
    { componentPath: "left/deep", subject: null },
    { componentPath: "left/deep/child", subject: null },
  ],
};

export const expected = {
  query: reading,
  mutation: reading,
  action: reading,
};
