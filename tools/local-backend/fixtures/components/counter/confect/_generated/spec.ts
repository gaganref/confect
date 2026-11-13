import { GroupSpec, Spec } from "@confect/core";
import authoring from "../authoring.spec.js";
import counter from "../counter.spec.js";
import deliveries from "../deliveries.spec.js";
import pagination from "../pagination.spec.js";
import reserved from "../reserved.spec.js";

const spec: Spec.Spec<{
  readonly authoring: GroupSpec.NamedAt<typeof authoring, "authoring">;
  readonly counter: GroupSpec.NamedAt<typeof counter, "counter">;
  readonly deliveries: GroupSpec.NamedAt<typeof deliveries, "deliveries">;
  readonly pagination: GroupSpec.NamedAt<typeof pagination, "pagination">;
  readonly reserved: GroupSpec.NamedAt<typeof reserved, "reserved">;
}> = Spec.fromGroups({
  ["authoring"]: authoring,
  ["counter"]: counter,
  ["deliveries"]: deliveries,
  ["pagination"]: pagination,
  ["reserved"]: reserved,
}) as typeof spec;

export default spec;
