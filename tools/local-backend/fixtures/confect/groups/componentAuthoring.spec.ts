import { Component, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import {
  ClassProbe,
  ProbeArgs,
  SystemIds,
} from "../../components/counter/confect/authoring.spec";
import { first } from "../componentBindings";

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "save",
      args: () => Component.schema(first, SystemIds).fields,
      returns: () => Component.id(first, "systemIds"),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "read",
      args: () => ({ id: Component.id(first, "systemIds") }),
      returns: () => Component.schema(first, SystemIds),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "probe",
      args: () => Component.schema(first, ProbeArgs).fields,
      returns: () => Component.schema(first, ClassProbe),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "render",
      args: () => ({ value: Schema.String }),
      returns: () => Schema.String,
    }),
  );
