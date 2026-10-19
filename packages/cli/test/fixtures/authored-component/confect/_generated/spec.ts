import { GroupSpec, Spec } from "@confect/core";
import counter from "../counter.spec.js";

const spec: Spec.Spec<{
  readonly counter: GroupSpec.NamedAt<typeof counter, "counter">;
}> = Spec.fromGroups({
  ["counter"]: counter,
}) as typeof spec;

export default spec;
