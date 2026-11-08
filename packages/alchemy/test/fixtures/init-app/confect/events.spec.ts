import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import events from "./_generated/tables/events";
import args from "./args";

const callback = (name: string) =>
  FunctionSpec.internalMutation({
    name,
    args: () => ({ fromName: Schema.String, message: Schema.String }),
    returns: () => Schema.Null,
  });

const group = GroupSpec.make()
  .addFunction(callback("record"))
  .addFunction(
    FunctionSpec.publicQuery({
      name: "list",
      returns: () => Schema.Array(events.Doc),
    }),
  );

export default args.withGone ? group.addFunction(callback("gone")) : group;
