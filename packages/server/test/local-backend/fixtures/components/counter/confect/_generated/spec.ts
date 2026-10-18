import { GroupSpec, Spec } from "@confect/core";
import authoring from "../authoring.spec";
import counter from "../counter.spec";
import deliveries from "../deliveries.spec";

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
