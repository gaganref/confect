import { GroupSpec } from "@confect/core";
import { args, profile, snapshot } from "../../../confect/reservedContext";

export default GroupSpec.make().addFunction(
  profile.publicMutation({ name: "echo", args, returns: snapshot }),
);
