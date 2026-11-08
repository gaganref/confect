import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import args from "./args";

const callback = (name: string) =>
  FunctionSpec.internalMutation({
    name,
    args: () => ({ fromName: Schema.String, message: Schema.String }),
    returns: () => Schema.Null,
  });

const group = GroupSpec.make().addFunction(callback("record"));

export default args.withGone ? group.addFunction(callback("gone")) : group;
