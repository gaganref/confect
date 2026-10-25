import { FunctionSpec, GroupSpec, Profile } from "@confect/core";
import * as Schema from "effect/Schema";
import ProvideViewer from "../middleware/ProvideViewer.spec";
import RequireName from "../middleware/RequireName.spec";

interface NameRule extends Profile.Fields {
  readonly Type: { readonly minLength: number };
}

const Named = FunctionSpec.extend<NameRule>()({
  middleware: [
    Profile.attach(RequireName, ({ fields }) => ({
      minLength: fields.minLength,
    })),
  ],
});

export default GroupSpec.make()
  .middleware(ProvideViewer)
  .middleware(RequireName, { minLength: 1 })
  .addFunction(
    FunctionSpec.publicQuery({
      name: "shortName",
      returns: () => Schema.String,
    }).middleware(RequireName, { minLength: 2 }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "longName",
      returns: () => Schema.String,
    }).middleware(RequireName, { minLength: 5 }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "mutation",
      returns: () => Schema.String,
    }).middleware(RequireName, { minLength: 4 }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "action",
      returns: () => Schema.String,
    }).middleware(RequireName, { minLength: 6 }),
  )
  .addFunction(
    Named.publicQuery({
      name: "profiledQuery",
      minLength: 3,
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    Named.publicMutation({
      name: "profiledMutation",
      minLength: 4,
      returns: () => Schema.String,
    }),
  );
