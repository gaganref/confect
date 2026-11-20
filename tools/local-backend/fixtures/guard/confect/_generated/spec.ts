import { GroupSpec, Spec } from "@confect/core";
import probe from "../probe.spec.js";
import probeNode from "../probeNode.spec.js";

const spec: Spec.Spec<{
  readonly probe: GroupSpec.NamedAt<typeof probe, "probe">;
  readonly probeNode: GroupSpec.NamedAt<typeof probeNode, "probeNode">;
}> = Spec.fromGroups({
  ["probe"]: probe,
  ["probeNode"]: probeNode,
}) as typeof spec;

export default spec;
