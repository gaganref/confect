import { GroupSpec, Spec } from "@confect/core";
import peers from "../peers.spec.js";
import peersNodeOne from "../peersNodeOne.spec.js";
import peersNodeTwo from "../peersNodeTwo.spec.js";

const spec: Spec.Spec<{
  readonly peers: GroupSpec.NamedAt<typeof peers, "peers">;
  readonly peersNodeOne: GroupSpec.NamedAt<typeof peersNodeOne, "peersNodeOne">;
  readonly peersNodeTwo: GroupSpec.NamedAt<typeof peersNodeTwo, "peersNodeTwo">;
}> = Spec.fromGroups({
  ["peers"]: peers,
  ["peersNodeOne"]: peersNodeOne,
  ["peersNodeTwo"]: peersNodeTwo,
}) as typeof spec;

export default spec;
