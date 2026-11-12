import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";

// Effect 4.1 moved crypto out of NodeServices; Alchemy's runtime supplies it.
export const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
