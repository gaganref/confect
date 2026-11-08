import { Callback, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import settings from "./_generated/tables/settings";
import { OnEvent } from "./callbacks";

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.internalMutation({
      name: "init",
      args: () => ({
        fromName: Schema.String,
        maxAttempts: Schema.optionalKey(Schema.Int),
        onEvent: Schema.optionalKey(Callback.handle(OnEvent)),
      }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "settings",
      returns: () => Schema.NullOr(settings.Doc),
    }),
  );
