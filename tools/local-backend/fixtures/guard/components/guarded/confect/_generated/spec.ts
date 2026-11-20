import { GroupSpec, Spec } from "@confect/core";
import probe from "../probe.spec.js";

const spec: Spec.Spec<{
  readonly probe: GroupSpec.NamedAt<typeof probe, "probe">;
}> = Spec.fromGroups({
  ["probe"]: probe,
}) as typeof spec;

export default spec;
