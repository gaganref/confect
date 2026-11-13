import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "./_generated/id";

export const SystemIds = Schema.Struct({
  storage: Id("_storage"),
  scheduled: Id("_scheduled_functions"),
});

export const ProbeArgs = Schema.Struct({ value: Schema.String });

// oxlint-disable-next-line effecttsgo/schema-class-missing-brand -- The private marker already makes this class nominal; the fixture checks that this survives component and host decoding, so a brand would hide what it tests.
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
      name: "mint",
      args: () => ({ expiresInSeconds: Schema.Finite }),
      returns: () => Schema.String,
    }),
  )
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
