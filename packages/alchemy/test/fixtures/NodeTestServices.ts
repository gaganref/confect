import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";

/**
 * Node services plus crypto. Effect 4.1 moved crypto out of NodeServices, and
 * Alchemy's runtime supplies it.
 *
 * @stability unstable
 */
export const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
