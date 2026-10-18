import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "./_generated/id";

export const SystemIds = Schema.Struct({
  storage: Id("_storage"),
  scheduled: Id("_scheduled_functions"),
});

export const ProbeArgs = Schema.Struct({ value: Schema.String });

export class ClassProbe extends Schema.Class<ClassProbe>("ClassProbe")({
  value: Schema.String,
}) {
  private readonly marker = "class";

  render() {
    return `${this.marker}:${this.value}`;
  }
}

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "save",
      args: () => SystemIds.fields,
      returns: () => Id("systemIds"),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "read",
      args: () => ({ id: Id("systemIds") }),
      returns: () => SystemIds,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "probe",
      args: () => ProbeArgs.fields,
      returns: () => ClassProbe,
    }),
  );
