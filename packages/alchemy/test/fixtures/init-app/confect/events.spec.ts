import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import args from "./args";

export const callback = <const Name extends string>(name: Name) =>
  FunctionSpec.internalMutation({
    name,
    args: () => ({ fromName: Schema.String, message: Schema.String }),
    returns: () => Schema.Null,
  });

const group = GroupSpec.make().addFunction(callback("record"));

export default args.withGone ? group.addFunction(callback("gone")) : group;
