import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

export default GroupSpec.make().addFunction(
  FunctionSpec.httpAction({
    name: "write",
    method: "POST",
    path: "/guarded",
    args: () => ({
      caseId: Schema.String,
      storageId: Schema.optionalKey(Schema.String),
      secret: Schema.optionalKey(Schema.String),
    }),
    returns: () => Schema.Null,
  }),
);
