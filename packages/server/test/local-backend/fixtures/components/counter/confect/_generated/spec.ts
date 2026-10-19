import { GroupSpec, Spec } from "@confect/core";
import authoring from "../authoring.spec.js";
import counter from "../counter.spec.js";
import deliveries from "../deliveries.spec.js";

const spec: Spec.Spec<{
  readonly authoring: GroupSpec.NamedAt<typeof authoring, "authoring">;
  readonly counter: GroupSpec.NamedAt<typeof counter, "counter">;
  readonly deliveries: GroupSpec.NamedAt<typeof deliveries, "deliveries">;
}> = Spec.fromGroups({
  ["authoring"]: authoring,
  ["counter"]: counter,
  ["deliveries"]: deliveries,
}) as typeof spec;

export default spec;
