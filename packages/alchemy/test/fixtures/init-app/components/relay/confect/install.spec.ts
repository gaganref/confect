import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import settings from "./_generated/tables/settings";

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.internalMutation({
      name: "init",
      args: () => ({ label: Schema.String }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "settings",
      returns: () => Schema.NullOr(settings.Doc),
    }),
  );
