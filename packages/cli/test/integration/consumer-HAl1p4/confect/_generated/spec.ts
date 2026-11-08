import { GroupSpec, Spec } from "@confect/core";
import notes from "../notes.spec.js";

const spec: Spec.Spec<{
  readonly notes: GroupSpec.NamedAt<typeof notes, "notes">;
}> = Spec.fromGroups({
  ["notes"]: notes,
}) as typeof spec;

export default spec;
